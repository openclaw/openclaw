import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveDefaultSessionStorePath, resolveSessionFilePath, resolveSessionFilePathOptions, resolveSessionTranscriptPath, } from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore, normalizeStoreSessionKey } from "./store.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
async function ensureSessionHeader(params) {
    if (fs.existsSync(params.sessionFile)) {
        return;
    }
    await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
    const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
    };
    await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
    });
}
export async function resolveSessionTranscriptFile(params) {
    const sessionPathOpts = resolveSessionFilePathOptions({
        agentId: params.agentId,
        storePath: params.storePath,
    });
    let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
    let sessionEntry = params.sessionEntry;
    if (params.sessionStore && params.storePath) {
        const threadIdFromSessionKey = parseSessionThreadInfo(params.sessionKey).threadId;
        const fallbackSessionFile = !sessionEntry?.sessionFile
            ? resolveSessionTranscriptPath(params.sessionId, params.agentId, params.threadId ?? threadIdFromSessionKey)
            : undefined;
        const resolvedSessionFile = await resolveAndPersistSessionFile({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionStore: params.sessionStore,
            storePath: params.storePath,
            sessionEntry,
            agentId: sessionPathOpts?.agentId,
            sessionsDir: sessionPathOpts?.sessionsDir,
            fallbackSessionFile,
        });
        sessionFile = resolvedSessionFile.sessionFile;
        sessionEntry = resolvedSessionFile.sessionEntry;
    }
    return {
        sessionFile,
        sessionEntry,
    };
}
export async function appendAssistantMessageToSessionTranscript(params) {
    const sessionKey = params.sessionKey.trim();
    if (!sessionKey) {
        return { ok: false, reason: "missing sessionKey" };
    }
    const mirrorText = resolveMirroredTranscriptText({
        text: params.text,
        mediaUrls: params.mediaUrls,
    });
    if (!mirrorText) {
        return { ok: false, reason: "empty text" };
    }
    return appendExactAssistantMessageToSessionTranscript({
        agentId: params.agentId,
        sessionKey,
        storePath: params.storePath,
        idempotencyKey: params.idempotencyKey,
        updateMode: params.updateMode,
        message: {
            role: "assistant",
            content: [{ type: "text", text: mirrorText }],
            api: "openai-responses",
            provider: "openclaw",
            model: "delivery-mirror",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
            },
            stopReason: "stop",
            timestamp: Date.now(),
        },
    });
}
export async function appendExactAssistantMessageToSessionTranscript(params) {
    const sessionKey = params.sessionKey.trim();
    if (!sessionKey) {
        return { ok: false, reason: "missing sessionKey" };
    }
    if (params.message.role !== "assistant") {
        return { ok: false, reason: "message role must be assistant" };
    }
    const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
    const store = loadSessionStore(storePath, { skipCache: true });
    const normalizedKey = normalizeStoreSessionKey(sessionKey);
    const entry = (store[normalizedKey] ?? store[sessionKey]);
    if (!entry?.sessionId) {
        return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
    }
    let sessionFile;
    try {
        const resolvedSessionFile = await resolveAndPersistSessionFile({
            sessionId: entry.sessionId,
            sessionKey,
            sessionStore: store,
            storePath,
            sessionEntry: entry,
            agentId: params.agentId,
            sessionsDir: path.dirname(storePath),
        });
        sessionFile = resolvedSessionFile.sessionFile;
    }
    catch (err) {
        return {
            ok: false,
            reason: formatErrorMessage(err),
        };
    }
    await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });
    const explicitIdempotencyKey = params.idempotencyKey ??
        params.message.idempotencyKey;
    const existingMessageId = explicitIdempotencyKey
        ? await transcriptHasIdempotencyKey(sessionFile, explicitIdempotencyKey)
        : undefined;
    if (existingMessageId) {
        return { ok: true, sessionFile, messageId: existingMessageId };
    }
    const latestEquivalentAssistantId = isRedundantDeliveryMirror(params.message)
        ? await findLatestEquivalentAssistantMessageId(sessionFile, params.message)
        : undefined;
    if (latestEquivalentAssistantId) {
        return { ok: true, sessionFile, messageId: latestEquivalentAssistantId };
    }
    const message = {
        ...params.message,
        ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
    };
    const sessionManager = SessionManager.open(sessionFile);
    const messageId = sessionManager.appendMessage(message);
    switch (params.updateMode ?? "inline") {
        case "inline":
            emitSessionTranscriptUpdate({ sessionFile, sessionKey, message, messageId });
            break;
        case "file-only":
            emitSessionTranscriptUpdate(sessionFile);
            break;
        case "none":
            break;
    }
    return { ok: true, sessionFile, messageId };
}
async function transcriptHasIdempotencyKey(transcriptPath, idempotencyKey) {
    try {
        const raw = await fs.promises.readFile(transcriptPath, "utf-8");
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) {
                continue;
            }
            try {
                const parsed = JSON.parse(line);
                if (parsed.message?.idempotencyKey === idempotencyKey &&
                    typeof parsed.id === "string" &&
                    parsed.id) {
                    return parsed.id;
                }
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function isRedundantDeliveryMirror(message) {
    return message.provider === "openclaw" && message.model === "delivery-mirror";
}
function extractAssistantMessageText(message) {
    if (!Array.isArray(message.content)) {
        return null;
    }
    const parts = message.content
        .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
        .map((part) => part.text.trim());
    return parts.length > 0 ? parts.join("\n").trim() : null;
}
async function findLatestEquivalentAssistantMessageId(transcriptPath, message) {
    const expectedText = extractAssistantMessageText(message);
    if (!expectedText) {
        return undefined;
    }
    try {
        const raw = await fs.promises.readFile(transcriptPath, "utf-8");
        const lines = raw.split(/\r?\n/);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const line = lines[index];
            if (!line.trim()) {
                continue;
            }
            try {
                const parsed = JSON.parse(line);
                const candidate = parsed.message;
                if (!candidate || candidate.role !== "assistant") {
                    continue;
                }
                const candidateText = extractAssistantMessageText(candidate);
                if (candidateText !== expectedText) {
                    return undefined;
                }
                if (typeof parsed.id === "string" && parsed.id) {
                    return parsed.id;
                }
                return undefined;
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
