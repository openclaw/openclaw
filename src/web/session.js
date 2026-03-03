import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeWASocket, useMultiFileAuthState, } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { formatCliCommand } from "../cli/command-format.js";
import { danger, success } from "../globals.js";
import { getChildLogger, toPinoLikeLogger } from "../logging.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import { VERSION } from "../version.js";
import { maybeRestoreCredsFromBackup, readCredsJsonRaw, resolveDefaultWebAuthDir, resolveWebCredsBackupPath, resolveWebCredsPath, } from "./auth-store.js";
export { getWebAuthAgeMs, logoutWeb, logWebSelfId, pickWebChannel, readWebSelfId, WA_WEB_AUTH_DIR, webAuthExists, } from "./auth-store.js";
let credsSaveQueue = Promise.resolve();
function enqueueSaveCreds(authDir, saveCreds, logger) {
    credsSaveQueue = credsSaveQueue
        .then(() => safeSaveCreds(authDir, saveCreds, logger))
        .catch((err) => {
        logger.warn({ error: String(err) }, "WhatsApp creds save queue error");
    });
}
async function safeSaveCreds(authDir, saveCreds, logger) {
    try {
        // Best-effort backup so we can recover after abrupt restarts.
        // Important: don't clobber a good backup with a corrupted/truncated creds.json.
        const credsPath = resolveWebCredsPath(authDir);
        const backupPath = resolveWebCredsBackupPath(authDir);
        const raw = readCredsJsonRaw(credsPath);
        if (raw) {
            try {
                JSON.parse(raw);
                fsSync.copyFileSync(credsPath, backupPath);
                try {
                    fsSync.chmodSync(backupPath, 0o600);
                }
                catch {
                    // best-effort on platforms that support it
                }
            }
            catch {
                // keep existing backup
            }
        }
    }
    catch {
        // ignore backup failures
    }
    try {
        await Promise.resolve(saveCreds());
        try {
            fsSync.chmodSync(resolveWebCredsPath(authDir), 0o600);
        }
        catch {
            // best-effort on platforms that support it
        }
    }
    catch (err) {
        logger.warn({ error: String(err) }, "failed saving WhatsApp creds");
    }
}
/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
export async function createWaSocket(printQr, verbose, opts = {}) {
    const baseLogger = getChildLogger({ module: "baileys" }, {
        level: verbose ? "info" : "silent",
    });
    const logger = toPinoLikeLogger(baseLogger, verbose ? "info" : "silent");
    const authDir = resolveUserPath(opts.authDir ?? resolveDefaultWebAuthDir());
    await ensureDir(authDir);
    const sessionLogger = getChildLogger({ module: "web-session" });
    maybeRestoreCredsFromBackup(authDir);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        version,
        logger,
        printQRInTerminal: false,
        browser: ["openclaw", "cli", VERSION],
        syncFullHistory: false,
        markOnlineOnConnect: false,
    });
    sock.ev.on("creds.update", () => enqueueSaveCreds(authDir, saveCreds, sessionLogger));
    sock.ev.on("connection.update", (update) => {
        try {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                opts.onQr?.(qr);
                if (printQr) {
                    console.log("Scan this QR in WhatsApp (Linked Devices):");
                    qrcode.generate(qr, { small: true });
                }
            }
            if (connection === "close") {
                const status = getStatusCode(lastDisconnect?.error);
                if (status === DisconnectReason.loggedOut) {
                    console.error(danger(`WhatsApp session logged out. Run: ${formatCliCommand("openclaw channels login")}`));
                }
            }
            if (connection === "open" && verbose) {
                console.log(success("WhatsApp Web connected."));
            }
        }
        catch (err) {
            sessionLogger.error({ error: String(err) }, "connection.update handler error");
        }
    });
    // Handle WebSocket-level errors to prevent unhandled exceptions from crashing the process
    if (sock.ws && typeof sock.ws.on === "function") {
        sock.ws.on("error", (err) => {
            sessionLogger.error({ error: String(err) }, "WebSocket error");
        });
    }
    return sock;
}
export async function waitForWaConnection(sock) {
    return new Promise((resolve, reject) => {
        const evWithOff = sock.ev;
        const handler = (...args) => {
            const update = (args[0] ?? {});
            if (update.connection === "open") {
                evWithOff.off?.("connection.update", handler);
                resolve();
            }
            if (update.connection === "close") {
                evWithOff.off?.("connection.update", handler);
                reject(update.lastDisconnect ?? new Error("Connection closed"));
            }
        };
        sock.ev.on("connection.update", handler);
    });
}
export function getStatusCode(err) {
    return (err?.output?.statusCode ??
        err?.status);
}
function safeStringify(value, limit = 800) {
    try {
        const seen = new WeakSet();
        const raw = JSON.stringify(value, (_key, v) => {
            if (typeof v === "bigint") {
                return v.toString();
            }
            if (typeof v === "function") {
                const maybeName = v.name;
                const name = typeof maybeName === "string" && maybeName.length > 0 ? maybeName : "anonymous";
                return `[Function ${name}]`;
            }
            if (typeof v === "object" && v) {
                if (seen.has(v)) {
                    return "[Circular]";
                }
                seen.add(v);
            }
            return v;
        }, 2);
        if (!raw) {
            return String(value);
        }
        return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
    }
    catch {
        return String(value);
    }
}
function extractBoomDetails(err) {
    if (!err || typeof err !== "object") {
        return null;
    }
    const output = err?.output;
    if (!output || typeof output !== "object") {
        return null;
    }
    const payload = output.payload;
    const statusCode = typeof output.statusCode === "number"
        ? output.statusCode
        : typeof payload?.statusCode === "number"
            ? payload.statusCode
            : undefined;
    const error = typeof payload?.error === "string" ? payload.error : undefined;
    const message = typeof payload?.message === "string" ? payload.message : undefined;
    if (!statusCode && !error && !message) {
        return null;
    }
    return { statusCode, error, message };
}
export function formatError(err) {
    if (err instanceof Error) {
        return err.message;
    }
    if (typeof err === "string") {
        return err;
    }
    if (!err || typeof err !== "object") {
        return String(err);
    }
    // Baileys frequently wraps errors under `error` with a Boom-like shape.
    const boom = extractBoomDetails(err) ??
        extractBoomDetails(err?.error) ??
        extractBoomDetails(err?.lastDisconnect?.error);
    const status = boom?.statusCode ?? getStatusCode(err);
    const code = err?.code;
    const codeText = typeof code === "string" || typeof code === "number" ? String(code) : undefined;
    const messageCandidates = [
        boom?.message,
        typeof err?.message === "string"
            ? err.message
            : undefined,
        typeof err?.error?.message === "string"
            ? err.error?.message
            : undefined,
    ].filter((v) => Boolean(v && v.trim().length > 0));
    const message = messageCandidates[0];
    const pieces = [];
    if (typeof status === "number") {
        pieces.push(`status=${status}`);
    }
    if (boom?.error) {
        pieces.push(boom.error);
    }
    if (message) {
        pieces.push(message);
    }
    if (codeText) {
        pieces.push(`code=${codeText}`);
    }
    if (pieces.length > 0) {
        return pieces.join(" ");
    }
    return safeStringify(err);
}
export function newConnectionId() {
    return randomUUID();
}
