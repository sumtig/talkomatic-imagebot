const io = require("socket.io-client");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// ============================================================
//  CONFIG — paste your bot token here to skip the prompt
// ============================================================
const BOT_TOKEN = "TOKEN_HERE";
const BOT_NAME = "Image Bot";
const BOT_LOCATION = "Open and \"save\" Images";
// ============================================================

const IDLE_TIMEOUT_MS = 60 * 1000;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(r => rl.question(q, r)); }

// ---------- loaders ----------

function loadBlockedUsers() {
  const fp = path.join(__dirname, "blocked_users.txt");
  if (!fs.existsSync(fp)) { console.warn("Warning: blocked_users.txt not found."); return new Set(); }
  return new Set(fs.readFileSync(fp, "utf8").split("\n").map(l => l.trim().toLowerCase()).filter(Boolean));
}

function fillPlaceholders(text, lockUsername) {
  return text.replace(/\{user\}/gi, lockUsername || "no one");
}

function loadTxtFile(name, lockUsername) {
  const reserved = ["blocked_users.txt", "main.txt"];
  const match = fs.readdirSync(__dirname).find(
    f => f.toLowerCase() === `${name.toLowerCase()}.txt` && !reserved.includes(f.toLowerCase())
  );
  if (!match) return null;
  return fillPlaceholders(fs.readFileSync(path.join(__dirname, match), "utf8").trim(), lockUsername);
}

function loadMainTxt(lockUsername) {
  const fp = path.join(__dirname, "main.txt");
  if (!fs.existsSync(fp)) return null;
  return fillPlaceholders(fs.readFileSync(fp, "utf8").trim(), lockUsername);
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

function findClosestFile(name) {
  const reserved = ["blocked_users.txt", "main.txt"];
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith(".txt") && !reserved.includes(f.toLowerCase()));
  if (!files.length) return null;
  let best = null, bestDist = Infinity;
  for (const f of files) {
    const baseName = f.replace(/\.txt$/i, "").toLowerCase();
    const dist = levenshtein(name.toLowerCase(), baseName);
    if (dist < bestDist) { bestDist = dist; best = f.replace(/\.txt$/i, ""); }
  }
  // Allow up to 40% of the longer string's length as distance threshold
  const maxDist = Math.max(3, Math.floor(Math.max(name.length, best ? best.length : 0) * 0.4));
  return bestDist <= maxDist ? best : null;
}

// ---------- ASCII video ----------

function loadVideo(name) {
  const dir = path.join(__dirname, "videos");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const vf = files.find(f => f.toLowerCase() === `${name.toLowerCase()}.txt`);
  if (!vf) return null;
  const frames = fs.readFileSync(path.join(dir, vf), "utf8").split(/\n\s*\n/).map(f => f.trim()).filter(Boolean);
  const base = vf.replace(/\.txt$/i, "");
  const cf = files.find(f => f.toLowerCase() === `${base.toLowerCase()}.config.txt`);
  let delay = 500;
  if (cf) { const m = fs.readFileSync(path.join(dir, cf), "utf8").match(/delay\s*[:=]\s*(\d+)/i); if (m) delay = parseInt(m[1]); }
  return { frames, delay };
}

async function playVideo(name, sendMessage, getImageOpen) {
  const video = loadVideo(name);
  if (!video) { sendMessage(`Error: Video "${name}" not found.`); return; }
  console.log(`Playing "${name}" — ${video.frames.length} frames @ ${video.delay}ms (looping)`);
  while (getImageOpen()) {
    for (const frame of video.frames) {
      if (!getImageOpen()) break;
      sendMessage(frame);
      await new Promise(r => setTimeout(r, video.delay));
    }
  }
  console.log(`Video "${name}" stopped.`);
}

// ---------- startup ----------

async function main() {
  console.log("=== Talkomatic Bot ===\n");
  const blockedUsers = loadBlockedUsers();
  console.log(`Loaded ${blockedUsers.size} blocked user(s).`);
  let botToken = BOT_TOKEN.trim();
  if (!botToken) {
    botToken = (await ask("Enter your Talkomatic bot token: ")).trim();
    if (!botToken) { console.log("Bot token cannot be empty. Exiting."); rl.close(); process.exit(1); }
  } else { console.log("Using hardcoded bot token.\n"); }
  askForRoomCode(botToken, blockedUsers);
}

function askForRoomCode(botToken, blockedUsers) {
  rl.question("Enter Talkomatic room code: ", (roomId) => {
    roomId = roomId.trim();
    if (!roomId) { console.log("Room code cannot be empty. Try again."); return askForRoomCode(botToken, blockedUsers); }
    connectBot(roomId, botToken, blockedUsers);
  });
}

// ---------- bot ----------

function connectBot(roomId, botToken, blockedUsers) {
  console.log(`Connecting to room ${roomId}...`);

  const socket = io("https://classic.talkomatic.co", {
    transports: ["websocket"], reconnection: false, auth: { token: botToken },
  });

  let users = {};
  let videoPlaying = false;
  let pendingConfirm = null;
  let imageOpen = false;
  let lock = null; // { userId, username, idleTimer }
  const debounceTimers = {};

  function sendMessage(text) {
    socket.emit("chat update", { diff: { type: "full-replace", text } });
  }

  function goMain() {
    imageOpen = false;
    const content = loadMainTxt(lock ? lock.username : null);
    sendMessage(content !== null ? content : "CONNECTED");
  }

  function releaseLock(reason) {
    if (!lock) return;
    console.log(`Lock released (${reason}). Was held by: ${lock.username}`);
    clearTimeout(lock.idleTimer);
    lock = null;
    goMain();
  }

  function resetIdleTimer() {
    if (!lock) return;
    clearTimeout(lock.idleTimer);
    lock.idleTimer = setTimeout(() => {
      console.log(`${lock.username} went idle. Releasing lock.`);
      sendMessage(`${lock.username} went idle. Releasing bot.`);
      lock = null;
      setTimeout(goMain, 1500);
    }, IDLE_TIMEOUT_MS);
  }

  function handleCommand(userId, author, current) {
    // ---------- pending yes/no confirmation ----------
    if (pendingConfirm) {
      if (userId !== pendingConfirm.userId) return;
      if (current === author.lastTriggered || !current) return;
      const answer = current.toLowerCase();
      if (answer === "yes") {
        author.lastTriggered = current;
        const content = loadTxtFile(pendingConfirm.suggestedFile, lock ? lock.username : null);
        console.log(`${author.username} confirmed: opening "${pendingConfirm.suggestedFile}"`);
        pendingConfirm = null; imageOpen = true;
        sendMessage(content !== null ? content : "Error: Could not load file.");
        resetIdleTimer(); return;
      }
      if (answer === "no") {
        author.lastTriggered = current;
        console.log(`${author.username} declined. Going back to main.`);
        pendingConfirm = null; goMain(); resetIdleTimer(); return;
      }
      author.lastTriggered = current;
      console.log(`${author.username} typed something else. Cancelling confirm.`);
      pendingConfirm = null;
      sendMessage(`${author.username} didn't respond. Going back.`);
      setTimeout(goMain, 1500); resetIdleTimer(); return;
    }

    if (current === author.lastTriggered || !current) return;

    // ---------- use image bot — anyone ----------
    if (current.toLowerCase() === "use image bot") {
      author.lastTriggered = current;
      if (lock) {
        if (lock.userId === userId) { goMain(); }
        else {
          const mc = loadMainTxt(lock.username);
          sendMessage(mc !== null ? mc : `Bot is in use by ${lock.username}.`);
          console.log(`${author.username} tried to use bot — locked by ${lock.username}`);
        }
        return;
      }
      lock = { userId, username: author.username, idleTimer: null };
      resetIdleTimer();
      console.log(`${author.username} locked the bot.`);
      goMain(); return;
    }

    // ---------- exit image bot — lock holder only ----------
    if (current.toLowerCase() === "exit image bot") {
      author.lastTriggered = current;
      if (lock && lock.userId === userId) { console.log(`${author.username} released the bot.`); releaseLock("user exited"); }
      return;
    }

    // ---------- require lock for all commands below ----------
    if (!lock || lock.userId !== userId) return;

    resetIdleTimer();

    // ---------- exit — always works while locked ----------
    if (current.toLowerCase() === "exit") {
      author.lastTriggered = current;
      console.log(`${author.username} used: exit`);
      goMain(); return;
    }

    // ---------- block everything else while image is open ----------
    if (imageOpen) return;

    // ---------- new ----------
    if (current.toLowerCase() === "new") {
      author.lastTriggered = current;
      console.log(`${author.username} used: new`);
      sendMessage("To add a new image, please ask zatr554 to add the image you want."); return;
    }

    // ---------- open filename or open (filename) ----------
    const openMatch = current.match(/^open\s+\((.+)\)$/i) || current.match(/^open\s+(.+)$/i);
    if (openMatch) {
      const fileName = openMatch[1].trim();
      if (!fileName) return;
      author.lastTriggered = current;
      const content = loadTxtFile(fileName, lock.username);
      if (content !== null) {
        // File found — open immediately, no delay needed
        console.log(`${author.username} opened: ${fileName}.txt`);
        imageOpen = true; sendMessage(content);
      } else {
        // File not found — wait 500ms then suggest closest match
        setTimeout(() => {
          const closest = findClosestFile(fileName);
          if (closest) {
            console.log(`${author.username} tried "${fileName}" — suggesting "${closest}"`);
            pendingConfirm = { userId, username: author.username, suggestedFile: closest };
            sendMessage(`"${fileName}.txt" not found. Did you mean "${closest}"? Type yes or no.`);
          } else {
            console.log(`${author.username} tried "${fileName}" — no match found`);
            sendMessage(`"${fileName}.txt" was not found and no similar files exist.`);
          }
        }, 500);
      }
      return;
    }

    // ---------- video videoname or video (videoname) ----------
    const videoMatch = current.match(/^video\s+\((.+)\)$/i) || current.match(/^video\s+(.+)$/i);
    if (videoMatch) {
      const videoName = videoMatch[1].trim();
      if (!videoName) return;
      author.lastTriggered = current;
      console.log(`${author.username} started video: ${videoName}`);
      if (videoPlaying) { sendMessage("A video is already playing, please wait."); return; }
      videoPlaying = true; imageOpen = true;
      playVideo(videoName, sendMessage, () => imageOpen).finally(() => { videoPlaying = false; }); return;
    }

    author.lastTriggered = "";
  }

  // ---------- socket events ----------

  let joinTimeout = setTimeout(() => {
    console.error(`Timed out joining room "${roomId}".`);
    socket.disconnect(); askForRoomCode(botToken, blockedUsers);
  }, 8000);

  socket.on("connect", () => {
    console.log("Socket connected! Joining lobby and room...");
    socket.emit("join lobby", { username: BOT_NAME, location: BOT_LOCATION });
    socket.emit("join room", { roomId });
  });

  socket.on("room joined", (data) => {
    clearTimeout(joinTimeout);
    console.log(`Successfully joined room "${roomId}"!`);
    users = Object.fromEntries(data.users.map(user => {
      if (!user.username) user.username = "Anonymous";
      if (!user.location) user.location = "Unknown";
      user.typing = data.currentMessages?.[user.id] ?? "";
      user.lastTriggered = "";
      return [user.id, user];
    }));
    goMain();
    console.log("Press Ctrl+C to disconnect.");
  });

  socket.on("user joined", (user) => {
    delete user.roomName; delete user.roomType;
    user.typing = ""; user.lastTriggered = "";
    users[user.id] = user;
  });

  socket.on("user left", (user_id) => {
    if (lock && lock.userId === user_id) {
      console.log(`${lock.username} left. Releasing lock.`);
      clearTimeout(lock.idleTimer); lock = null; goMain();
    }
    if (pendingConfirm && pendingConfirm.userId === user_id) {
      console.log(`${pendingConfirm.username} left during confirmation.`);
      pendingConfirm = null; goMain();
    }
    delete users[user_id];
  });

  socket.on("chat update", (data) => {
    const author = users[data.userId];
    if (!author) return;

    // Apply diff
    if (data.diff) {
      if (data.diff.type === "full-replace") {
        author.typing = data.diff.text;
      } else {
        let cur = author.typing;
        switch (data.diff.type) {
          case "add":     author.typing = cur.slice(0, data.diff.index) + data.diff.text + cur.slice(data.diff.index); break;
          case "delete":  author.typing = cur.slice(0, data.diff.index) + cur.slice(data.diff.index + data.diff.count); break;
          case "replace": author.typing = cur.slice(0, data.diff.index) + data.diff.text + cur.slice(data.diff.index + data.diff.text.length + 1); break;
        }
      }
    } else {
      author.typing = data.message ?? author.typing;
    }

    const current = author.typing.replace(/\n/g, "").trim();
    const username = (author.username || "").toLowerCase();
    if (blockedUsers.has(username)) return;

    // For open/video commands, check immediately if the file exists and open instantly.
    // The debounce below still handles the not-found/error path via handleCommand.
    if (lock && lock.userId === data.userId && !imageOpen) {
      const quickOpen = current.match(/^open\s+\((.+)\)$/i) || current.match(/^open\s+(.+)$/i);
      if (quickOpen) {
        const fileName = quickOpen[1].trim();
        if (fileName && current !== author.lastTriggered) {
          const content = loadTxtFile(fileName, lock.username);
          if (content !== null) {
            author.lastTriggered = current;
            if (debounceTimers[data.userId]) { clearTimeout(debounceTimers[data.userId]); delete debounceTimers[data.userId]; }
            console.log(`${author.username} opened: ${fileName}.txt`);
            imageOpen = true; sendMessage(content);
            resetIdleTimer();
            return;
          }
        }
      }
      const quickVideo = current.match(/^video\s+\((.+)\)$/i) || current.match(/^video\s+(.+)$/i);
      if (quickVideo) {
        const videoName = quickVideo[1].trim();
        if (videoName && current !== author.lastTriggered) {
          if (loadVideo(videoName)) {
            author.lastTriggered = current;
            if (debounceTimers[data.userId]) { clearTimeout(debounceTimers[data.userId]); delete debounceTimers[data.userId]; }
            console.log(`${author.username} started video: ${videoName}`);
            if (!videoPlaying) { videoPlaying = true; imageOpen = true; playVideo(videoName, sendMessage, () => imageOpen).finally(() => { videoPlaying = false; }); }
            resetIdleTimer();
            return;
          }
        }
      }
    }

    // Debounce: wait 1 second of no typing before firing (handles errors, suggestions, other commands)
    if (debounceTimers[data.userId]) clearTimeout(debounceTimers[data.userId]);
    debounceTimers[data.userId] = setTimeout(() => {
      delete debounceTimers[data.userId];
      handleCommand(data.userId, author, current);
    }, 1000);
  });

  socket.on("connect_error", (err) => {
    clearTimeout(joinTimeout);
    console.error(`Could not connect: ${err.message}`);
    socket.disconnect(); askForRoomCode(botToken, blockedUsers);
  });

  socket.on("disconnect", (reason) => {
    clearTimeout(joinTimeout);
    if (reason !== "io client disconnect") { console.error(`Disconnected: ${reason}`); askForRoomCode(botToken, blockedUsers); }
  });

  socket.on("error", (msg) => { clearTimeout(joinTimeout); console.error(`Server error: ${msg}`); socket.disconnect(); askForRoomCode(botToken, blockedUsers); });
  socket.on("room error", (msg) => { clearTimeout(joinTimeout); console.error(`Room error: ${msg}`); socket.disconnect(); askForRoomCode(botToken, blockedUsers); });
}

main();
