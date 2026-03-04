export function parseTelegramReplyToMessageId(replyToId?: string | null): number | undefined {
  if (!replyToId) {
    return undefined;
  }
  // Reject non-integer strings (e.g. UUIDs from webchat) that parseInt would partially parse.
  return parseIntegerId(replyToId);
}

function parseIntegerId(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseTelegramThreadId(threadId?: string | number | null): number | undefined {
  if (threadId == null) {
    return undefined;
  }
  if (typeof threadId === "number") {
    if (!Number.isFinite(threadId)) {
      return undefined;
    }
    const normalized = Math.trunc(threadId);
    return Number.isSafeInteger(normalized) ? normalized : undefined;
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
