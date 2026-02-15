const SIGNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+?[0-9][0-9\s().-]*$/;
const MAX_ENTRIES = 5000;
const TTL_MS = 24 * 60 * 60 * 1000;

type SignalReactionTarget = {
  groupId: string;
  messageId: string;
  targetAuthorUuid?: string;
  targetAuthor?: string;
  recordedAt: number;
};

const reactionTargetByGroupMessage = new Map<string, SignalReactionTarget>();

function normalizeGroupId(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return (
    trimmed
      .replace(/^signal:/i, "")
      .replace(/^group:/i, "")
      .trim() || undefined
  );
}

function normalizeMessageId(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeUuid(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = trimmed
    .replace(/^signal:/i, "")
    .replace(/^uuid:/i, "")
    .trim();
  return SIGNAL_UUID_RE.test(stripped) ? stripped : undefined;
}

function normalizePhone(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !PHONE_RE.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function makeKey(groupId: string, messageId: string): string {
  return `${groupId}:${messageId}`;
}

function pruneIfNeeded(): void {
  const now = Date.now();
  for (const [key, value] of reactionTargetByGroupMessage.entries()) {
    if (now - value.recordedAt > TTL_MS) {
      reactionTargetByGroupMessage.delete(key);
    }
  }
  if (reactionTargetByGroupMessage.size <= MAX_ENTRIES) {
    return;
  }
  const sorted = Array.from(reactionTargetByGroupMessage.entries()).toSorted(
    (a, b) => a[1].recordedAt - b[1].recordedAt,
  );
  const overflow = reactionTargetByGroupMessage.size - MAX_ENTRIES;
  for (let i = 0; i < overflow; i += 1) {
    const key = sorted[i]?.[0];
    if (key) {
      reactionTargetByGroupMessage.delete(key);
    }
  }
}

export function recordSignalReactionTarget(params: {
  groupId?: string;
  messageId?: string;
  senderId?: string;
  senderE164?: string;
}): void {
  const groupId = normalizeGroupId(params.groupId);
  const messageId = normalizeMessageId(params.messageId);
  if (!groupId || !messageId) {
    return;
  }
  const targetAuthorUuid = normalizeUuid(params.senderId);
  const targetAuthor = normalizePhone(params.senderE164) ?? normalizePhone(params.senderId);
  if (!targetAuthorUuid && !targetAuthor) {
    return;
  }
  reactionTargetByGroupMessage.set(makeKey(groupId, messageId), {
    groupId,
    messageId,
    targetAuthorUuid,
    targetAuthor,
    recordedAt: Date.now(),
  });
  pruneIfNeeded();
}

export function resolveSignalReactionTarget(params: {
  groupId?: string;
  messageId?: string;
}): { targetAuthorUuid?: string; targetAuthor?: string } | undefined {
  const groupId = normalizeGroupId(params.groupId);
  const messageId = normalizeMessageId(params.messageId);
  if (!groupId || !messageId) {
    return undefined;
  }
  const hit = reactionTargetByGroupMessage.get(makeKey(groupId, messageId));
  if (!hit) {
    return undefined;
  }
  if (Date.now() - hit.recordedAt > TTL_MS) {
    reactionTargetByGroupMessage.delete(makeKey(groupId, messageId));
    return undefined;
  }
  return {
    targetAuthorUuid: hit.targetAuthorUuid,
    targetAuthor: hit.targetAuthor,
  };
}

export function __clearSignalReactionTargetCacheForTests(): void {
  reactionTargetByGroupMessage.clear();
}
