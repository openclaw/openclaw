export function parseTelegramReplyToMessageId(replyToId) {
    if (!replyToId) {
        return undefined;
    }
    const parsed = Number.parseInt(replyToId, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function parseIntegerId(value) {
    if (!/^-?\d+$/.test(value)) {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
export function parseTelegramThreadId(threadId) {
    if (threadId == null) {
        return undefined;
    }
    if (typeof threadId === "number") {
        return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
    }
    const trimmed = threadId.trim();
    if (!trimmed) {
        return undefined;
    }
    // DM topic session keys may scope thread ids as "<chatId>:<threadId>".
    const scopedMatch = /^-?\d+:(-?\d+)$/.exec(trimmed);
    const rawThreadId = scopedMatch ? scopedMatch[1] : trimmed;
    return parseIntegerId(rawThreadId);
}
