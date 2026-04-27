import { normalizeOptionalString } from "../shared/string-coerce.js";
const SESSION_TRANSCRIPT_LISTENERS = new Set();
export function onSessionTranscriptUpdate(listener) {
    SESSION_TRANSCRIPT_LISTENERS.add(listener);
    return () => {
        SESSION_TRANSCRIPT_LISTENERS.delete(listener);
    };
}
export function emitSessionTranscriptUpdate(update) {
    const normalized = typeof update === "string"
        ? { sessionFile: update }
        : {
            sessionFile: update.sessionFile,
            sessionKey: update.sessionKey,
            message: update.message,
            messageId: update.messageId,
        };
    const trimmed = normalizeOptionalString(normalized.sessionFile);
    if (!trimmed) {
        return;
    }
    const nextUpdate = {
        sessionFile: trimmed,
        ...(normalizeOptionalString(normalized.sessionKey)
            ? { sessionKey: normalizeOptionalString(normalized.sessionKey) }
            : {}),
        ...(normalized.message !== undefined ? { message: normalized.message } : {}),
        ...(normalizeOptionalString(normalized.messageId)
            ? { messageId: normalizeOptionalString(normalized.messageId) }
            : {}),
    };
    for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
        try {
            listener(nextUpdate);
        }
        catch {
            /* ignore */
        }
    }
}
