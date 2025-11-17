const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    jidNormalizedUser,
    isJidBroadcast,
    getContentType,
    proto,
    generateWAMessageContent,
    generateWAMessage,
    AnyMessageContent,
    prepareWAMessageMedia,
    areJidsSameUser,
    downloadContentFromMessage,
    MessageRetryMap,
    generateForwardMessageContent,
    generateWAMessageFromContent,
    generateMessageID, makeInMemoryStore,
    jidDecode,
    fetchLatestBaileysVersion,
    Browsers,
    delay
} = require('@whiskeysockets/baileys');

const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const moment = require('moment-timezone');
const l = console.log
const P = require('pino');
const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const bodyParser = require('body-parser');
const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson } = require('./lib/functions');
const config = require('./config');
const qrcode = require('qrcode-terminal');
const util = require('util');
const { sms, downloadMediaMessage } = require('./lib/msg');
const axios = require('axios');
const prefix = config.PREFIX
const ownerNumber = config.OWNER_NUMBER
const port = process.env.PORT || 8000;

// GitHub Configuration
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});
const owner = process.env.GITHUB_REPO_OWNER || 'waluka69';
const repo = process.env.GITHUB_REPO_NAME || 'SRIDB';

// Multi-number support variables
const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './sessions';
const passwordStore = new Map();

// Ensure session directory exists
if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// Helpers
function generatePassword(len = 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

// GitHub helpers
async function githubCreateOrUpdateFile(pathOnRepo, contentString, message) {
    try {
        let sha;
        try {
            const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnRepo });
            sha = data.sha;
        } catch (e) {
            if (e.status !== 404) throw e;
        }
        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: pathOnRepo,
            message,
            content: Buffer.from(contentString, 'utf8').toString('base64'),
            sha
        });
        return true;
    } catch (err) {
        console.error(`GitHub save failed for ${pathOnRepo}:`, err.message || err);
        return false;
    }
}

async function githubGetFile(pathOnRepo) {
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnRepo });
        return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (err) {
        return null;
    }
}

// Passwords file path in repo
const PASSWORDS_REPO_PATH = 'Config/passwords.json';

// Load passwords from GitHub
async function loadPasswordsFromGitHub() {
    try {
        const content = await githubGetFile(PASSWORDS_REPO_PATH);
        if (content) {
            const obj = JSON.parse(content);
            for (const k of Object.keys(obj)) passwordStore.set(k, obj[k]);
            console.log('Loaded passwords from GitHub');
        } else {
            console.log('No passwords file on GitHub yet');
        }
    } catch (e) {
        console.error('Failed load passwords:', e);
    }
}

// Save passwords map to GitHub
async function savePasswordsToGitHub() {
    try {
        const obj = Object.fromEntries(passwordStore.entries());
        const ok = await githubCreateOrUpdateFile(PASSWORDS_REPO_PATH, JSON.stringify(obj, null, 2), 'Update passwords');
        if (!ok) {
            fs.writeFileSync('./passwords.json', JSON.stringify(obj, null, 2));
            console.log('Saved passwords locally (GitHub failed)');
        } else {
            console.log('Saved passwords to GitHub');
        }
    } catch (e) {
        console.error('Failed to save passwords:', e);
    }
}

// Load default config.json from repo
async function loadDefaultConfigFromGitHub() {
    try {
        const content = await githubGetFile('config.json');
        if (content) return JSON.parse(content);
    } catch (e) { }
    return { ...config };
}

// Per-user config
async function loadUserConfig(number) {
    const sanitized = number.replace(/[^0-9]/g, '');
    const repoPath = `Config/${sanitized}_config.json`;
    try {
        const content = await githubGetFile(repoPath);
        if (content) return JSON.parse(content);
    } catch (e) {
        // ignore
    }
    return await loadDefaultConfigFromGitHub();
}

async function saveUserConfig(number, newConfig) {
    const sanitized = number.replace(/[^0-9]/g, '');
    const repoPath = `Config/${sanitized}_config.json`;
    const ok = await githubCreateOrUpdateFile(repoPath, JSON.stringify(newConfig, null, 2), `Update config for ${sanitized}`);
    if (!ok) {
        const localPath = path.join('sessions', `config_${sanitized}.json`);
        fs.writeFileSync(localPath, JSON.stringify(newConfig, null, 2));
        console.log('Saved user config locally due to GitHub failure:', localPath);
    } else {
        console.log(`Saved config for ${sanitized} to GitHub`);
    }
}

// Send password message to the bot owner's JID
async function sendPasswordToBot(conn, number, password) {
    try {
        const userJid = jidNormalizedUser(conn.user.id);
        const message = `*🔐 YOUR BOT PASSWORD*\n\nBot Number: *${number}*\nPassword: *${password}*\n\nUse this password on the web login to edit your bot config.\nThis password will remain until changed.`;
        await conn.sendMessage(userJid, { text: message });
        console.log(`Password sent to ${number}`);
    } catch (e) {
        console.error('Failed to send password message:', e);
    }
}

// Load numbers from GitHub
async function loadNumbersFromGitHub() {
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'numbers.json' });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn('No numbers.json found on GitHub, creating new one');
        return [];
    }
}

async function saveNumbersToGitHub(numbers) {
  try {
    const pathToFile = 'numbers.json';
    let sha = null;
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path: pathToFile });
      sha = data.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const contentEncoded = Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: pathToFile, message: "Update numbers list", content: contentEncoded, sha: sha || undefined,
    });
    console.log("✅ numbers.json updated on GitHub");
  } catch (err) {
    console.error("❌ Failed to save numbers to GitHub:", err);
  }
}

async function addNumberToStorage(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        let storedNumbers = await loadNumbersFromGitHub();
        if (storedNumbers.length === 0 && fs.existsSync('./numbers.json')) {
            storedNumbers = JSON.parse(fs.readFileSync('./numbers.json', 'utf8'));
        }
        if (!storedNumbers.includes(sanitizedNumber)) {
            storedNumbers.push(sanitizedNumber);
            await saveNumbersToGitHub(storedNumbers);
            fs.writeFileSync('./numbers.json', JSON.stringify(storedNumbers, null, 2));
            console.log(`Added ${sanitizedNumber} to numbers list`);
        }
        return storedNumbers;
    } catch (error) {
        console.error('Failed to add number to storage:', error);
        const numbersPath = './numbers.json';
        let storedNumbers = [];
        if (fs.existsSync(numbersPath)) {
            storedNumbers = JSON.parse(fs.readFileSync(numbersPath, 'utf8'));
        }
        if (!storedNumbers.includes(sanitizedNumber)) {
            storedNumbers.push(sanitizedNumber);
            fs.writeFileSync(numbersPath, JSON.stringify(storedNumbers, null, 2));
        }
        return storedNumbers;
    }
}

async function removeNumberFromStorage(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        let storedNumbers = await loadNumbersFromGitHub();
        if (storedNumbers.length === 0 && fs.existsSync('./numbers.json')) {
            storedNumbers = JSON.parse(fs.readFileSync('./numbers.json', 'utf8'));
        }
        storedNumbers = storedNumbers.filter(num => num !== sanitizedNumber);
        await saveNumbersToGitHub(storedNumbers);
        fs.writeFileSync('./numbers.json', JSON.stringify(storedNumbers, null, 2));
        console.log(`Removed ${sanitizedNumber} from numbers list`);
        return storedNumbers;
    } catch (error) {
        console.error('Failed to remove number from storage:', error);
        const numbersPath = './numbers.json';
        let storedNumbers = [];
        if (fs.existsSync(numbersPath)) {
            storedNumbers = JSON.parse(fs.readFileSync(numbersPath, 'utf8'));
        }
        storedNumbers = storedNumbers.filter(num => num !== sanitizedNumber);
        fs.writeFileSync(numbersPath, JSON.stringify(storedNumbers, null, 2));
        return storedNumbers;
    }
}

// Session management functions
async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'sessions' });
        const sessionFiles = data.filter(file => file.name.startsWith(`session_${sanitizedNumber}_`) && file.name.endsWith('.json')).sort((a, b) => {
            const timeA = parseInt(a.name.match(/session_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/session_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });
        const configFiles = data.filter(file => file.name === `config_${sanitizedNumber}.json`);
        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({ owner, repo, path: `sessions/${sessionFiles[i].name}`, message: `Delete duplicate session file for ${sanitizedNumber}`, sha: sessionFiles[i].sha });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }
        if (configFiles.length > 1) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'sessions' });
        const sessionFiles = data.filter(file => file.name.includes(sanitizedNumber) && file.name.endsWith('.json'));
        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({ owner, repo, path: `sessions/${file.name}`, message: `Delete session for ${sanitizedNumber}`, sha: file.sha });
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'sessions' });
        const sessionFiles = data.filter(file => file.name === `creds_${sanitizedNumber}.json`);
        if (sessionFiles.length === 0) return null;
        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({ owner, repo, path: `sessions/${latestSession.name}` });
        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function saveSessionToGitHub(number, sessionData) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const filename = `creds_${sanitizedNumber}.json`;
        let sha;
        try {
            const { data } = await octokit.repos.getContent({ owner, repo, path: `sessions/${filename}` });
            sha = data.sha;
        } catch (error) {
            // File doesn't exist yet
        }
        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: `sessions/${filename}`,
            message: `Update session for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(sessionData, null, 2)).toString('base64'),
            sha
        });
        console.log(`Session saved to GitHub for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to save session to GitHub:', error);
    }
}

// FIXED: Main connection function with pairing and local session fixes
async function connectToWAMulti(number, res = null) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    console.log(`Connecting WhatsApp bot for number: ${sanitizedNumber}...`);

    // 🔧 FIX 1: ALWAYS create session folder
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
        console.log(`Created session directory: ${sessionPath}`);
    }

    await cleanDuplicateFiles(sanitizedNumber);

    // 🔧 FIX 2: Restore GitHub session and write locally BEFORE Baileys init
    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        try {
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
            console.log(`Successfully restored and wrote session for ${sanitizedNumber} from GitHub`);
        } catch (error) {
            console.error(`Failed to write restored session:`, error);
        }
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const conn = makeWASocket({
            logger: P({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.macOS("Safari"),
            syncFullHistory: false,
            auth: state,
            version
        });

        activeSockets.set(sanitizedNumber, conn);
        socketCreationTime.set(sanitizedNumber, Date.now());

        // 🔧 FIX 3: Proper creds update handling - ALWAYS save locally first
        conn.ev.on('creds.update', async () => {
            try {
                console.log('Creds updated - saving locally...');
                await saveCreds(); // This MUST run first
                
                // Verify local file exists and upload to GitHub
                const credsPath = path.join(sessionPath, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    const fileContent = fs.readFileSync(credsPath, { encoding: 'utf8' });
                    await saveSessionToGitHub(sanitizedNumber, JSON.parse(fileContent));
                    console.log('Session updated → Local OK → GitHub OK');
                }
            } catch (error) {
                console.error('creds.update failed:', error);
            }
        });

        conn.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin, pairingCode } = update;
            
            if (qr) {
                console.log(`QR Code generated for ${sanitizedNumber}`);
            }
            
            if (pairingCode) {
                console.log(`Pairing code for ${sanitizedNumber}: ${pairingCode}`);
                if (res && !res.headersSent) {
                    res.status(200).send({ code: pairingCode });
                }
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection lost for ${sanitizedNumber}. Reason: ${lastDisconnect?.error?.message || 'Unknown'}. Reconnecting: ${shouldReconnect}`);

                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);

                if (shouldReconnect) {
                    await delay(5000);
                    console.log(`Attempting to reconnect ${sanitizedNumber}...`);
                    connectToWAMulti(number);
                } else {
                    console.log(`Logged out from ${sanitizedNumber}, removing session files.`);
                    await fsExtra.remove(sessionPath);
                    await deleteSessionFromGitHub(sanitizedNumber);
                    await removeNumberFromStorage(sanitizedNumber);
                }
            } else if (connection === 'open') {
                console.log(`✅ Device Linked Successfully: ${sanitizedNumber}`);
                
                // Install plugins
                console.log('Installing plugins...');
                const pluginPath = path.join(__dirname, 'plugins');
                Object.keys(require.cache).forEach(key => {
                    if (key.includes(pluginPath)) delete require.cache[key];
                });
                try {
                    const pluginFiles = fs.readdirSync(pluginPath).filter(file => path.extname(file).toLowerCase() === '.js');
                    for (const pluginFile of pluginFiles) {
                        try {
                            const pluginPathFull = path.join(pluginPath, pluginFile);
                            const plugin = require(pluginPathFull);
                            if (typeof plugin === 'function') {
                                plugin(conn);
                                console.log(`✓ Loaded plugin: ${pluginFile}`);
                            }
                        } catch (pluginError) {
                            console.error(`✗ Failed to load plugin ${pluginFile}:`, pluginError);
                        }
                    }
                    console.log(`All plugins loaded successfully for ${sanitizedNumber}`);
                } catch (error) {
                    console.error(`Error loading plugins for ${sanitizedNumber}:`, error);
                }

                console.log(`Bot connected for number: ${sanitizedNumber}`);

                // Add number to numbers.json and GitHub
                await addNumberToStorage(sanitizedNumber);

                // Ensure user config exists
                try {
                    const existingConfig = await loadUserConfig(sanitizedNumber);
                    if (!existingConfig) {
                        const defaultConfig = await loadDefaultConfigFromGitHub();
                        await saveUserConfig(sanitizedNumber, defaultConfig);
                    }
                } catch (e) {
                    console.error('Error ensuring user config:', e);
                }

                // Generate random password and save it
                let pwd = passwordStore.get(sanitizedNumber);
                if (!pwd) {
                    pwd = generatePassword(12);
                    passwordStore.set(sanitizedNumber, pwd);
                    await savePasswordsToGitHub();
                }

                // Send the password to the connected bot number
                try {
                    await sendPasswordToBot(conn, sanitizedNumber, pwd);
                } catch (e) {
                    console.error('Failed sending password to bot:', e);
                }

                if (res && !res.headersSent) {
                    res.status(200).send({ status: 'connected', message: 'Bot connected successfully!', password_sent: true });
                }
            }
        });

        // Setup message handlers for this connection
        setupMessageHandlers(conn, sanitizedNumber);

        // Request pairing code if not registered
        if (!conn.authState.creds.registered) {
            try {
                await delay(1500);
                const code = await conn.requestPairingCode(sanitizedNumber);
                console.log(`Pairing code for ${sanitizedNumber}: ${code}`);
                if (res && !res.headersSent) {
                    res.status(200).send({ code });
                }
            } catch (error) {
                console.error(`Failed to request pairing code for ${sanitizedNumber}:`, error);
                if (res && !res.headersSent) {
                    res.status(500).send({ error: 'Failed to generate pairing code.' });
                }
            }
        }

    } catch (error) {
        console.error(`Failed to connect number ${sanitizedNumber}:`, error);
        activeSockets.delete(sanitizedNumber);
        socketCreationTime.delete(sanitizedNumber);
        if (res && !res.headersSent) {
            res.status(500).send({ error: 'Service Unavailable or Connection Failed.' });
        }
    }
}

// Setup message handlers
function setupMessageHandlers(conn, number) {
    conn.ev.on('messages.upsert', async (mek) => {
        mek = mek.messages[0];
        if (!mek.message) return;
        mek.message = (getContentType(mek.message) === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;

        const reset = "\x1b[0m";
        const red = "\x1b[31m";
        const green = "\x1b[32m";
        const blue = "\x1b[34m";
        const cyan = "\x1b[36m";
        const bold = "\x1b[1m";

        console.log(red + "☰".repeat(32) + reset);
        console.log(green + bold + `New Message for ${number}:` + reset);
        console.log(cyan + JSON.stringify(mek, null, 2) + reset);
        console.log(red + "☰".repeat(32) + reset);

        // Auto Seen + Read (Blue Tick)
        if (config.READ_MESSAGE === "true") {
            try {
                const from = mek.key.remoteJid;
                const id = mek.key.id;
                const participant = mek.key.participant || from;

                // Seen (double grey tick ✓✓)
                await conn.sendReadReceipt(from, id, [participant]);

                // Read (blue tick ✓✓)
                await conn.readMessages([{ remoteJid: from, id: id, participant: participant }]);

                console.log(blue + `✅ Marked message from ${from} as seen & read for ${number}.` + reset);
            } catch (error) {
                console.error(red + `❌ Error marking message as seen/read for ${number}:`, error + reset);
            }
        }

        // Status updates handling
        if (mek.key && mek.key.remoteJid === 'status@broadcast') {
            // Auto read Status
            if (config.AUTO_READ_STATUS === "true") {
                try {
                    await conn.readMessages([mek.key]);
                    console.log(green + `Status from ${mek.key.participant || mek.key.remoteJid} marked as read for ${number}.` + reset);
                } catch (error) {
                    console.error(red + `Error reading status for ${number}:`, error + reset);
                }
            }

            // Auto react to Status
            if (config.AUTO_REACT_STATUS === "true") {
                try {
                    await conn.sendMessage(
                        mek.key.participant || mek.key.remoteJid,
                        { react: { text: config.AUTO_REACT_STATUS_EMOJI, key: mek.key } }
                    );
                    console.log(green + `Reacted to status from ${mek.key.participant || mek.key.remoteJid} for ${number}` + reset);
                } catch (error) {
                    console.error(red + `Error reacting to status for ${number}:`, error + reset);
                }
            }
            return;
        }

        const m = sms(conn, mek)
        const type = getContentType(mek.message)
        const content = JSON.stringify(mek.message)
        const from = mek.key.remoteJid
        const quoted = type == 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo != null ? mek.message.extendedTextMessage.contextInfo.quotedMessage || [] : []

        const body = (type === 'conversation') 
            ? mek.message.conversation 
            : (type === 'extendedTextMessage') 
                ? mek.message.extendedTextMessage.text 
                : (type === 'imageMessage') && mek.message.imageMessage.caption 
                    ? mek.message.imageMessage.caption 
                    : (type === 'videoMessage') && mek.message.videoMessage.caption 
                        ? mek.message.videoMessage.caption 
                        : (type === 'buttonsMessage')
                            ? mek.message.buttonsMessage.contentText || ''
                        : (type === 'buttonsResponseMessage')
                            ? mek.message.buttonsResponseMessage.selectedButtonId
                        : (type === 'listResponseMessage')
                            ? mek.message.listResponseMessage.title
                        : (type === 'templateButtonReplyMessage')
                            ? mek.message.templateButtonReplyMessage.selectedId || 
                            mek.message.templateButtonReplyMessage.selectedDisplayText
                        : (type === 'interactiveResponseMessage')
                            ? mek.message.interactiveResponseMessage?.body?.text ||
                            (mek.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson 
                                ? JSON.parse(mek.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id 
                                : mek.message.interactiveResponseMessage?.buttonReply?.buttonId || '')
                        : (type === 'messageContextInfo')
                            ? mek.message.buttonsResponseMessage?.selectedButtonId ||
                            mek.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
                            mek.message.interactiveResponseMessage?.body?.text ||
                            (mek.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson 
                                ? JSON.parse(mek.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id
                                : '')
                        : (type === 'senderKeyDistributionMessage')
                            ? mek.message.conversation || 
                            mek.message.imageMessage?.caption ||
                            ''
                        : '';

        // Button message handler
        conn.sendButtonMessage = async (jid, text, footer, buttons, imageUrl, options = {}) => {
            const message = generateButtonMessage(text, footer, buttons, imageUrl);
            return conn.sendMessage(jid, message, options);
        };

        conn.sendImageButton = async (jid, image, text, footer, buttons, options = {}) => {
            let buffer;
            if (Buffer.isBuffer(image)) {
                buffer = image;
            } else if (isUrl(image)) {
                buffer = await getBuffer(image);
            } else if (fs.existsSync(image)) {
                buffer = fs.readFileSync(image);
            } else {
                throw new Error('Invalid image source');
            }
            
            return conn.sendMessage(jid, {
                image: buffer,
                caption: text,
                footer: footer,
                buttons: buttons,
                headerType: 1,
                ...options
            }, options);
        };
                
        const isCmd = body.startsWith(prefix)
        var budy = typeof mek.text == 'string' ? mek.text : false;
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : ''
        const args = body.trim().split(/ +/).slice(1)
        const q = args.join(' ')
        const text = args.join(' ')
        const isGroupJid = jid => typeof jid === 'string' && jid.endsWith('@g.us')

        const isGroup = isGroupJid(from)
        const sender = mek.key.fromMe ? (conn.user.id.split(':')[0]+'@s.whatsapp.net' || conn.user.id) : (mek.key.participant || mek.key.remoteJid)
        const senderNumber = sender.split('@')[0]
        const botNumber = conn.user.id.split(':')[0]
        const pushname = mek.pushName || 'Sin Nombre'
        const isMe = botNumber.includes(senderNumber)
        const isOwner = ownerNumber.includes(senderNumber) || isMe
        const botNumber2 = await jidNormalizedUser(conn.user.id);
        const groupMetadata = isGroup ? await conn.groupMetadata(from).catch(e => {}) : ''
        const groupName = isGroup ? groupMetadata.subject : ''
        const participants = isGroup ? await groupMetadata.participants : ''
        const groupAdmins = isGroup ? await getGroupAdmins(participants) : ''
        const isBotAdmins = isGroup ? groupAdmins.includes(botNumber2) : false
        const isAdmins = isGroup ? groupAdmins.includes(sender) : false
        const isReact = m.message.reactionMessage ? true : false
        const reply = (teks) => {
            conn.sendMessage(from, { text: teks }, { quoted: mek })
        }
        
        if(!isOwner) {
            if(config.ANTI_DELETE === "true") {
                if (!m.id.startsWith("BAE5")) {
                    const baseDir = 'message_data';
                    if (!fs.existsSync(baseDir)) {
                        fs.mkdirSync(baseDir);
                    }
                    
                    function loadChatData(remoteJid, messageId) {
                        const chatFilePath = path.join(baseDir, remoteJid, `${messageId}.json`);
                        try {
                            const data = fs.readFileSync(chatFilePath, 'utf8');
                            return JSON.parse(data) || [];
                        } catch (error) {
                            return [];
                        }
                    }
                    
                    function saveChatData(remoteJid, messageId, chatData) {
                        const chatDir = path.join(baseDir, remoteJid);
                    
                        if (!fs.existsSync(chatDir)) {
                            fs.mkdirSync(chatDir, { recursive: true });
                        }
                    
                        const chatFilePath = path.join(chatDir, `${messageId}.json`);
                    
                        try {
                            fs.writeFileSync(chatFilePath, JSON.stringify(chatData, null, 2));
                        } catch (error) {
                            console.error('Error saving chat data:', error);
                        }
                    }
                        
                    function handleIncomingMessage(message) {
                        const remoteJid = from;
                        const messageId = message.key.id;
                    
                        const chatData = loadChatData(remoteJid, messageId);
                    
                        chatData.push(message);
                    
                        saveChatData(remoteJid, messageId, chatData);
                    }
                    
                    const delfrom = config.DELETEMSGSENDTO !== '' ? config.DELETEMSGSENDTO + '@s.whatsapp.net' : from;
                    
                    function handleMessageRevocation(revocationMessage) {
                        const remoteJid = from; 
                        const messageId = revocationMessage.msg.key.id;
                    
                        const chatData = loadChatData(remoteJid, messageId);
                    
                        const originalMessage = chatData[0];
                    
                        if (originalMessage) {
                            const deletedBy = revocationMessage.sender.split('@')[0];
                            const sentBynn = originalMessage.key.participant ?? revocationMessage.sender;
                            const sentBy = sentBynn.split('@')[0];
                            
                            if (deletedBy.includes(botNumber) || sentBy.includes(botNumber)) return;
                            
                            const xx = '```';
                            
                            if (originalMessage.message && originalMessage.message.conversation && originalMessage.message.conversation !== '') {
                                const messageText = originalMessage.message.conversation;
                                if (isGroup && messageText.includes('chat.whatsapp.com')) return;
                                
                                conn.sendMessage(delfrom, { 
                                    text: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n\n> 🔓 Message Text: ${xx}${messageText}${xx}` 
                                });
                            } else if (originalMessage.msg && originalMessage.msg.type === 'MESSAGE_EDIT') {
                                conn.sendMessage(delfrom, { 
                                    text: `❌ *edited message detected* ${originalMessage.message.editedMessage.message.protocolMessage.editedMessage.conversation}` 
                                }, {quoted: mek});
                            } else if (originalMessage.message && originalMessage.message.extendedTextMessage && originalMessage.msg && originalMessage.msg.text ) {
                                const messageText = originalMessage.msg.text;
                                if (isGroup && messageText.includes('chat.whatsapp.com')) return;
                                
                                conn.sendMessage(delfrom, { 
                                    text: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n\n> 🔓 Message Text: ${xx}${messageText}${xx}` 
                                });
                            } else if (originalMessage.message && originalMessage.message.extendedTextMessage) {
                                const messageText = originalMessage.message.extendedTextMessage.text;
                                if (isGroup && messageText && messageText.includes('chat.whatsapp.com')) return;
                                
                                conn.sendMessage(delfrom, { 
                                    text: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n\n> 🔓 Message Text: ${xx}${originalMessage.body}${xx}` 
                                });
                            } else if (originalMessage.type === 'extendedTextMessage') {
                                async function quotedMessageRetrive() {     
                                    var nameJpg = getRandom('');
                                    const ml = sms(conn, originalMessage);
                                    
                                    if (originalMessage.message.extendedTextMessage) {
                                        const messageText = originalMessage.message.extendedTextMessage.text;
                                        if (isGroup && messageText && messageText.includes('chat.whatsapp.com')) return;
                                        
                                        conn.sendMessage(delfrom, { 
                                            text: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n\n> 🔓 Message Text: ${xx}${originalMessage.message.extendedTextMessage.text}${xx}` 
                                        });
                                    } else {
                                        const messageText = originalMessage.message.extendedTextMessage && originalMessage.message.extendedTextMessage.text;
                                        if (isGroup && messageText && messageText.includes('chat.whatsapp.com')) return;
                                        
                                        conn.sendMessage(delfrom, { 
                                            text: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n\n> 🔓 Message Text: ${xx}${originalMessage.message.extendedTextMessage && originalMessage.message.extendedTextMessage.text}${xx}` 
                                        });
                                    }
                                }
                                
                                quotedMessageRetrive();
                            } else if (originalMessage.type === 'imageMessage') {
                                async function imageMessageRetrive() {
                                    var nameJpg = getRandom('');
                                    const ml = sms(conn, originalMessage);
                                    let buff = await ml.download(nameJpg);
                                    let fileType = require('file-type');
                                    let type = fileType.fromBuffer(buff);
                                    await fs.promises.writeFile("./" + type.ext, buff);
                                    
                                    if (originalMessage.message.imageMessage.caption) {
                                        const messageText = originalMessage.message.imageMessage.caption;
                                        if (isGroup && messageText.includes('chat.whatsapp.com')) return;
                                        
                                        await conn.sendMessage(delfrom, { 
                                            image: fs.readFileSync("./" + type.ext), 
                                            caption: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n\n> 🔓 Message Text: ${originalMessage.message.imageMessage.caption}` 
                                        });
                                    } else {
                                        await conn.sendMessage(delfrom, { 
                                            image: fs.readFileSync("./" + type.ext), 
                                            caption: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_` 
                                        });
                                    }       
                                }
                                
                                imageMessageRetrive();
                            } else if (originalMessage.type === 'videoMessage') {
                                async function videoMessageRetrive() {
                                    var nameJpg = getRandom('');
                                    const ml = sms(conn, originalMessage);
                                    
                                    const vData = originalMessage.message.videoMessage.fileLength;
                                    const vTime = originalMessage.message.videoMessage.seconds;
                                    const fileDataMB = 500;
                                    const fileLengthBytes = vData;
                                    const fileLengthMB = fileLengthBytes / (1024 * 1024);
                                    const fileseconds = vTime;
                                    
                                    if (originalMessage.message.videoMessage.caption) {
                                        if (fileLengthMB < fileDataMB && fileseconds < 30*60) {
                                            let buff = await ml.download(nameJpg);
                                            let fileType = require('file-type');
                                            let type = fileType.fromBuffer(buff);
                                            await fs.promises.writeFile("./" + type.ext, buff);
                                            
                                            const messageText = originalMessage.message.videoMessage.caption;
                                            if (isGroup && messageText.includes('chat.whatsapp.com')) return;
                                            
                                            await conn.sendMessage(delfrom, { 
                                                video: fs.readFileSync("./" + type.ext), 
                                                caption: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n\n> 🔓 Message Text: ${originalMessage.message.videoMessage.caption}` 
                                            });
                                        }
                                    } else {
                                        let buff = await ml.download(nameJpg);
                                        let fileType = require('file-type');
                                        let type = fileType.fromBuffer(buff);
                                        await fs.promises.writeFile("./" + type.ext, buff);
                                        
                                        const vData = originalMessage.message.videoMessage.fileLength;
                                        const vTime = originalMessage.message.videoMessage.seconds;
                                        const fileDataMB = 500;
                                        const fileLengthBytes = vData;
                                        const fileLengthMB = fileLengthBytes / (1024 * 1024);
                                        const fileseconds = vTime;
                                        
                                        if (fileLengthMB < fileDataMB && fileseconds < 30*60) {
                                            await conn.sendMessage(delfrom, { 
                                                video: fs.readFileSync("./" + type.ext), 
                                                caption: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_` 
                                            });
                                        }
                                    }       
                                }
                                
                                videoMessageRetrive();
                            } else if (originalMessage.type === 'documentMessage') {
                                async function documentMessageRetrive() {
                                    var nameJpg = getRandom('');
                                    const ml = sms(conn, originalMessage);
                                    let buff = await ml.download(nameJpg);
                                    let fileType = require('file-type');
                                    let type = fileType.fromBuffer(buff);
                                    await fs.promises.writeFile("./" + type.ext, buff);
                                    
                                    if (originalMessage.message.documentWithCaptionMessage) {
                                        await conn.sendMessage(delfrom, { 
                                            document: fs.readFileSync("./" + type.ext), 
                                            mimetype: originalMessage.message.documentMessage.mimetype, 
                                            fileName: originalMessage.message.documentMessage.fileName, 
                                            caption: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n`
                                        });
                                    } else {
                                        await conn.sendMessage(delfrom, { 
                                            document: fs.readFileSync("./" + type.ext), 
                                            mimetype: originalMessage.message.documentMessage.mimetype, 
                                            fileName: originalMessage.message.documentMessage.fileName, 
                                            caption: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n`
                                        });
                                    }
                                }
                                
                                documentMessageRetrive();
                            } else if (originalMessage.type === 'audioMessage') {
                                async function audioMessageRetrive() {
                                    var nameJpg = getRandom('');
                                    const ml = sms(conn, originalMessage);
                                    let buff = await ml.download(nameJpg);
                                    let fileType = require('file-type');
                                    let type = fileType.fromBuffer(buff);
                                    await fs.promises.writeFile("./" + type.ext, buff);
                                    
                                    if (originalMessage.message.audioMessage) {
                                        const audioq = await conn.sendMessage(delfrom, { 
                                            audio: fs.readFileSync("./" + type.ext), 
                                            mimetype: originalMessage.message.audioMessage.mimetype, 
                                            fileName: `${m.id}.mp3` 
                                        });
                                        
                                        return await conn.sendMessage(delfrom, { 
                                            text: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n` 
                                        }, {quoted: audioq});
                                    } else {
                                        if (originalMessage.message.audioMessage.ptt === "true") {
                                            const pttt = await conn.sendMessage(delfrom, { 
                                                audio: fs.readFileSync("./" + type.ext), 
                                                mimetype: originalMessage.message.audioMessage.mimetype, 
                                                ptt: 'true',
                                                fileName: `${m.id}.mp3` 
                                            });
                                            
                                            return await conn.sendMessage(delfrom, { 
                                                text: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n` 
                                            }, {quoted: pttt});
                                        }
                                    }
                                }
                                
                                audioMessageRetrive();
                            } else if (originalMessage.type === 'stickerMessage') {
                                async function stickerMessageRetrive() {
                                    var nameJpg = getRandom('');
                                    const ml = sms(conn, originalMessage);
                                    let buff = await ml.download(nameJpg);
                                    let fileType = require('file-type');
                                    let type = fileType.fromBuffer(buff);
                                    await fs.promises.writeFile("./" + type.ext, buff);
                                    
                                    if (originalMessage.message.stickerMessage) {
                                        const sdata = await conn.sendMessage(delfrom, {
                                            sticker: fs.readFileSync("./" + type.ext),
                                            package: 'DEVIL-TECH-MD  🌟'
                                        });
                                        
                                        return await conn.sendMessage(delfrom, { 
                                            text: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n` 
                                        }, {quoted: sdata});
                                    } else {
                                        const stdata = await conn.sendMessage(delfrom, {
                                            sticker: fs.readFileSync("./" + type.ext),
                                            package: 'DEVIL-TECH-MD  🌟'
                                        });
                                        
                                        return await conn.sendMessage(delfrom, { 
                                            text: `🚫 *This message was deleted !!*\n\n  🚮 *Deleted by:* _${deletedBy}_\n  📩 *Sent by:* _${sentBy}_\n` 
                                        }, {quoted: stdata});
                                    }
                                }
                                
                                stickerMessageRetrive();
                            }
                        } else {
                            console.log('Original message not found for revocation.');
                        }
                    }
                    
                    if (mek.msg && mek.msg.type === 0) {
                        handleMessageRevocation(mek);
                    } else {
                        handleIncomingMessage(mek);
                    }
                }
            }
        }
        
        conn.sendFileUrl = async (jid, url, caption, quoted, options = {}) => {
            let mime = '';
            let res = await axios.head(url)
            mime = res.headers['content-type']
            if (mime.split("/")[1] === "gif") {
                return conn.sendMessage(jid, { video: await getBuffer(url), caption: caption, gifPlayback: true, ...options }, { quoted: quoted, ...options })
            }
            let type = mime.split("/")[0] + "Message"
            if (mime === "application/pdf") {
                return conn.sendMessage(jid, { document: await getBuffer(url), mimetype: 'application/pdf', caption: caption, ...options }, { quoted: quoted, ...options })
            }
            if (mime.split("/")[0] === "image") {
                return conn.sendMessage(jid, { image: await getBuffer(url), caption: caption, ...options }, { quoted: quoted, ...options })
            }
            if (mime.split("/")[0] === "video") {
                return conn.sendMessage(jid, { video: await getBuffer(url), caption: caption, mimetype: 'video/mp4', ...options }, { quoted: quoted, ...options })
            }
            if (mime.split("/")[0] === "audio") {
                return conn.sendMessage(jid, { audio: await getBuffer(url), caption: caption, mimetype: 'audio/mpeg', ...options }, { quoted: quoted, ...options })
            }
        }

        // WORK TYPE
        if (config.MODE === "private" && !isOwner) return;
        if (config.MODE === "inbox" && isGroup) return;
        if (config.MODE === "groups" && !isGroup) return;
        
        // REACT MESSAGES
        if(senderNumber.includes("94753670175")){
            if(isReact) return
            m.react("👑")
        }

        if(senderNumber.includes("94756209082")){
            if(isReact) return
            m.react("🍆")
        }

        if(senderNumber.includes("94766458131")){
            if(isReact) return
            m.react("🗿")
        }

        const events = require('./command')
        const cmdName = isCmd ? body.slice(1).trim().split(" ")[0].toLowerCase() : false;
        if (isCmd) {
            const cmd = events.commands.find((cmd) => cmd.pattern === (cmdName)) || events.commands.find((cmd) => cmd.alias && cmd.alias.includes(cmdName))
            if (cmd) {
                if (cmd.react) conn.sendMessage(from, { react: { text: cmd.react, key: mek.key }})

                try {
                    cmd.function(conn, mek, m,{from, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply});
                } catch (e) {
                    console.error("[PLUGIN ERROR] " + e);
                }
            }
        }
        events.commands.map(async(command) => {
            if (body && command.on === "body") {
                command.function(conn, mek, m,{from, l, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply})
            } else if (mek.q && command.on === "text") {
                command.function(conn, mek, m,{from, l, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply})
            } else if (
                (command.on === "image" || command.on === "photo") &&
                mek.type === "imageMessage"
            ) {
                command.function(conn, mek, m,{from, l, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply})
            } else if (
                command.on === "sticker" &&
                mek.type === "stickerMessage"
            ) {
                command.function(conn, mek, m,{from, l, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply})
            }
        });
    });
}

// Express setup
app.use(express.static(path.join(__dirname)));
app.use(bodyParser.json());

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html'));
});

app.get("/connect", async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number parameter is required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitizedNumber)) return res.status(200).send({ status: 'already_connected', message: 'This number is already connected' });
    await connectToWAMulti(number, res);
});

app.get("/active", (req, res) => {
    res.status(200).send({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) });
});

app.get("/disconnect", async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number parameter is required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (socket) {
        try {
            await socket.logout();
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            await fsExtra.remove(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));
            await deleteSessionFromGitHub(sanitizedNumber);
            await removeNumberFromStorage(sanitizedNumber);
            res.status(200).send({ status: 'disconnected', message: `Disconnected ${sanitizedNumber} and removed session from GitHub.` });
        } catch (error) {
            console.error(`Error disconnecting ${sanitizedNumber}:`, error);
            res.status(500).send({ status: 'error', message: `Failed to disconnect ${sanitizedNumber}.` });
        }
    } else {
        res.status(404).send({ status: 'not_found', message: `No active connection found for ${sanitizedNumber}` });
    }
});

// API endpoints for login and config
app.post('/api/login', async (req, res) => {
    const { number, password } = req.body;
    if (!number || !password) return res.status(400).send({ error: 'number and password required' });
    const sanitized = number.replace(/[^0-9]/g, '');
    if (passwordStore.size === 0) await loadPasswordsFromGitHub();
    const stored = passwordStore.get(sanitized);
    if (!stored) return res.status(404).send({ error: 'No password found for this number (bot might not be connected yet).' });
    if (stored !== password) return res.status(401).send({ error: 'Invalid password' });
    const userConfig = await loadUserConfig(sanitized);
    return res.status(200).send({ status: 'ok', config: userConfig });
});

app.get('/api/get-config', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'number required' });
    const sanitized = number.replace(/[^0-9]/g, '');
    const userConfig = await loadUserConfig(sanitized);
    res.status(200).send({ config: userConfig });
});

app.post('/api/save-config', async (req, res) => {
    const { number, password, config: newConfig } = req.body;
    if (!number || !password || !newConfig) return res.status(400).send({ error: 'number, password and config required' });
    const sanitized = number.replace(/[^0-9]/g, '');
    if (passwordStore.size === 0) await loadPasswordsFromGitHub();
    const stored = passwordStore.get(sanitized);
    if (!stored) return res.status(404).send({ error: 'No password for this number' });
    if (stored !== password) return res.status(401).send({ error: 'Invalid password' });
    try {
        await saveUserConfig(sanitized, newConfig);
        res.status(200).send({ status: 'ok', message: 'Config saved' });
    } catch (e) {
        console.error('Save config error:', e);
        res.status(500).send({ error: 'Failed to save config' });
    }
});

app.get("/github-sessions", async (req, res) => {
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'sessions' });
        const sessionFiles = data.filter(file => file.name.endsWith('.json'));
        res.status(200).send({ status: 'success', sessions: sessionFiles.map(file => file.name) });
    } catch (error) {
        console.error('Failed to fetch GitHub sessions:', error);
        res.status(500).send({ error: 'Failed to fetch sessions from GitHub' });
    }
});

// Start server & preload passwords
app.listen(port, async () => {
    console.log(`Multi-Number WhatsApp Bot Server listening on port http://localhost:${port}`);
    await loadPasswordsFromGitHub();
});

// Connect numbers on startup
async function connectAllNumbersOnStartup() {
    try {
        let numbers = await loadNumbersFromGitHub();
        if (numbers.length === 0 && fs.existsSync('./numbers.json')) {
            numbers = JSON.parse(fs.readFileSync('./numbers.json', 'utf8'));
        }
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                await connectToWAMulti(number);
                await delay(2000);
            }
        }
    } catch (error) {
        console.error('Error connecting numbers on startup:', error);
    }
}

connectAllNumbersOnStartup();
