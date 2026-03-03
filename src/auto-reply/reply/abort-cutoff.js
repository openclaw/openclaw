import { updateSessionStore } from "../../config/sessions.js";
export function resolveAbortCutoffFromContext(ctx) {
    const messageSid = (typeof ctx.MessageSidFull === "string" && ctx.MessageSidFull.trim()) ||
        (typeof ctx.MessageSid === "string" && ctx.MessageSid.trim()) ||
        undefined;
    const timestamp = typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
    if (!messageSid && timestamp === undefined) {
        return undefined;
    }
    return { messageSid, timestamp };
}
export function readAbortCutoffFromSessionEntry(entry) {
    if (!entry) {
        return undefined;
    }
    const messageSid = entry.abortCutoffMessageSid?.trim() || undefined;
    const timestamp = typeof entry.abortCutoffTimestamp === "number" && Number.isFinite(entry.abortCutoffTimestamp)
        ? entry.abortCutoffTimestamp
        : undefined;
    if (!messageSid && timestamp === undefined) {
        return undefined;
    }
    return { messageSid, timestamp };
}
export function hasAbortCutoff(entry) {
    return readAbortCutoffFromSessionEntry(entry) !== undefined;
}
export function applyAbortCutoffToSessionEntry(entry, cutoff) {
    entry.abortCutoffMessageSid = cutoff?.messageSid;
    entry.abortCutoffTimestamp = cutoff?.timestamp;
}
export async function clearAbortCutoffInSession(params) {
    const { sessionEntry, sessionStore, sessionKey, storePath } = params;
    if (!sessionEntry || !sessionStore || !sessionKey || !hasAbortCutoff(sessionEntry)) {
        return false;
    }
    applyAbortCutoffToSessionEntry(sessionEntry, undefined);
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
        await updateSessionStore(storePath, (store) => {
            const existing = store[sessionKey] ?? sessionEntry;
            if (!existing) {
                return;
            }
            applyAbortCutoffToSessionEntry(existing, undefined);
            existing.updatedAt = Date.now();
            store[sessionKey] = existing;
        });
    }
    return true;
}
function toNumericMessageSid(value) {
    const trimmed = value?.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
        return undefined;
    }
    try {
        return BigInt(trimmed);
    }
    catch {
        return undefined;
    }
}
export function shouldSkipMessageByAbortCutoff(params) {
    const cutoffSid = params.cutoffMessageSid?.trim();
    const currentSid = params.messageSid?.trim();
    if (cutoffSid && currentSid) {
        const cutoffNumeric = toNumericMessageSid(cutoffSid);
        const currentNumeric = toNumericMessageSid(currentSid);
        if (cutoffNumeric !== undefined && currentNumeric !== undefined) {
            return currentNumeric <= cutoffNumeric;
        }
        if (currentSid === cutoffSid) {
            return true;
        }
    }
    if (typeof params.cutoffTimestamp === "number" &&
        Number.isFinite(params.cutoffTimestamp) &&
        typeof params.timestamp === "number" &&
        Number.isFinite(params.timestamp)) {
        return params.timestamp <= params.cutoffTimestamp;
    }
    return false;
}
export function shouldPersistAbortCutoff(params) {
    const commandSessionKey = params.commandSessionKey?.trim();
    const targetSessionKey = params.targetSessionKey?.trim();
    if (!commandSessionKey || !targetSessionKey) {
        return true;
    }
    // Native targeted /stop can run from a slash/session-control key while the
    // actual target session uses different message id/timestamp spaces.
    // Persist cutoff only when command source and target are the same session.
    return commandSessionKey === targetSessionKey;
}
