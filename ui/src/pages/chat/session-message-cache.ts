// Control UI chat module implements bounded visible-message caching.
import {
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import type { ChatHistoryPagination } from "./chat-history.ts";
import { readTranscriptSequence } from "./history-merge.ts";
import { getSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";

// JSON code-unit weight bounds retained payloads without allocating another
// UTF-8 buffer on the route-switch path.
const MAX_CACHED_CHAT_SNAPSHOT_WEIGHT = 12 * 1024 * 1024;
const MAX_CACHED_CHAT_WEIGHT = 24 * 1024 * 1024;

export type ChatSessionSnapshot = {
  messages: unknown[];
  pagination: ChatHistoryPagination;
  sessionId: string | null;
};

type CachedChatSessionSnapshot = {
  // The producing array identifies an unchanged snapshot so route exit can
  // refresh LRU order without rescanning a long transcript.
  sourceMessages: unknown[];
  snapshot: ChatSessionSnapshot;
  weight: number;
};

export type ChatMessageCache = Map<string, CachedChatSessionSnapshot>;

type ChatMessageCacheTarget = {
  sessionKey: string;
  agentId?: string | null;
};

type ChatMessageCacheHost = Pick<
  UiSessionDefaultsHost,
  "assistantAgentId" | "agentsList" | "hello"
>;

function resolveCacheAgentId(host: ChatMessageCacheHost, target: ChatMessageCacheTarget): string {
  const explicitAgentId = target.agentId?.trim();
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  const parsed = parseAgentSessionKey(target.sessionKey);
  if (parsed) {
    return normalizeAgentId(parsed.agentId);
  }
  return isUiGlobalSessionKey(target.sessionKey)
    ? resolveUiSelectedGlobalAgentId(host)
    : resolveUiDefaultAgentId(host);
}

function resolveCanonicalSessionKey(host: ChatMessageCacheHost, sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  const normalized = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  const configuredMainKey = resolveUiConfiguredMainKey(host);
  return isUiGlobalSessionKey(sessionKey) ||
    normalized === DEFAULT_MAIN_KEY ||
    normalized === configuredMainKey
    ? DEFAULT_MAIN_KEY
    : normalized;
}

function resolveChatMessageCacheKey(
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): string {
  const agentId = resolveCacheAgentId(host, target);
  const sessionKey = resolveCanonicalSessionKey(host, target.sessionKey);
  return `agent:${agentId}:${sessionKey}`;
}

export function cacheChatMessages(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  messages: unknown[],
): void {
  const cacheKey = resolveChatMessageCacheKey(host, target);
  const existing = getSessionCacheValue(cache, cacheKey)?.snapshot;
  cacheChatSessionSnapshot(cache, host, target, {
    messages,
    pagination: existing?.pagination ?? { hasMore: false },
    sessionId: existing?.sessionId ?? null,
  });
}

export function appendChatMessageToCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  message: unknown,
): void {
  const cacheKey = resolveChatMessageCacheKey(host, target);
  const existing = getSessionCacheValue(cache, cacheKey);
  if (!existing) {
    cacheChatSessionSnapshot(cache, host, target, {
      messages: [message],
      pagination: { hasMore: false },
      sessionId: null,
    });
    return;
  }
  const messageWeight = serializedWeight(message);
  if (messageWeight === null) {
    cache.delete(cacheKey);
    return;
  }
  const snapshot = {
    messages: [...existing.snapshot.messages, message],
    pagination: existing.snapshot.pagination,
    sessionId: existing.snapshot.sessionId,
  };
  const weight = existing.weight + messageWeight + 1;
  if (weight > MAX_CACHED_CHAT_SNAPSHOT_WEIGHT) {
    cacheChatSessionSnapshot(cache, host, target, snapshot);
    return;
  }
  setSessionCacheValue(cache, cacheKey, { snapshot, sourceMessages: snapshot.messages, weight });
  trimChatSessionSnapshotCache(cache);
}

export function readChatMessagesFromCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): unknown[] {
  return readChatSessionSnapshot(cache, host, target)?.messages ?? [];
}

export function clearChatMessagesFromCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): void {
  cache.delete(resolveChatMessageCacheKey(host, target));
}

export function cacheChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  snapshot: ChatSessionSnapshot,
): void {
  const cacheKey = resolveChatMessageCacheKey(host, target);
  const existing = getSessionCacheValue(cache, cacheKey);
  if (
    existing?.sourceMessages === snapshot.messages &&
    existing.snapshot.sessionId === snapshot.sessionId &&
    samePagination(existing.snapshot.pagination, snapshot.pagination)
  ) {
    return;
  }
  if (
    snapshot.messages.length === 0 &&
    snapshot.sessionId === null &&
    snapshot.pagination.hasMore === false &&
    (snapshot.pagination.totalMessages ?? 0) === 0 &&
    snapshot.pagination.completeSnapshot !== true
  ) {
    cache.delete(cacheKey);
    return;
  }
  const bounded = boundChatSessionSnapshot(snapshot);
  if (!bounded) {
    cache.delete(cacheKey);
    return;
  }
  setSessionCacheValue(cache, cacheKey, bounded);
  trimChatSessionSnapshotCache(cache);
}

export function readChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): ChatSessionSnapshot | null {
  const cached = getSessionCacheValue(cache, resolveChatMessageCacheKey(host, target));
  if (!cached) {
    return null;
  }
  const messages = [...cached.snapshot.messages];
  cached.sourceMessages = messages;
  return {
    messages,
    pagination: { ...cached.snapshot.pagination },
    sessionId: cached.snapshot.sessionId,
  };
}

function boundChatSessionSnapshot(snapshot: ChatSessionSnapshot): CachedChatSessionSnapshot | null {
  const snapshotWeight = serializedWeight(snapshot);
  if (snapshotWeight === null) {
    return null;
  }
  if (snapshotWeight <= MAX_CACHED_CHAT_SNAPSHOT_WEIGHT) {
    return {
      sourceMessages: snapshot.messages,
      snapshot: {
        messages: [...snapshot.messages],
        pagination: { ...snapshot.pagination },
        sessionId: snapshot.sessionId,
      },
      weight: snapshotWeight,
    };
  }
  const messageWeights = snapshot.messages.map(serializedWeight);
  if (messageWeights.some((weight) => weight === null)) {
    return null;
  }
  let start = 0;
  let weight = serializedWeight({
    messages: [],
    pagination: snapshot.pagination,
    sessionId: snapshot.sessionId,
  });
  if (weight === null) {
    return null;
  }
  for (const messageWeight of messageWeights) {
    weight += (messageWeight ?? 0) + 1;
  }
  while (weight > MAX_CACHED_CHAT_SNAPSHOT_WEIGHT && start < snapshot.messages.length) {
    const boundarySeq = readTranscriptSequence(snapshot.messages[start]);
    do {
      weight -= (messageWeights[start] ?? 0) + 1;
      start += 1;
    } while (
      boundarySeq !== null &&
      start < snapshot.messages.length &&
      readTranscriptSequence(snapshot.messages[start]) === boundarySeq
    );
  }
  const messages = snapshot.messages.slice(start);
  const pagination =
    start === 0 ? snapshot.pagination : capSnapshotPagination(snapshot.pagination, messages);
  if (!pagination) {
    return null;
  }
  return {
    sourceMessages: snapshot.messages,
    snapshot: {
      messages,
      pagination: { ...pagination },
      sessionId: snapshot.sessionId,
    },
    weight,
  };
}

function capSnapshotPagination(
  pagination: ChatHistoryPagination,
  messages: unknown[],
): ChatHistoryPagination | null {
  const totalMessages = pagination.totalMessages;
  const oldestSeq = messages.map(readTranscriptSequence).find((seq) => seq !== null);
  if (typeof totalMessages !== "number" || oldestSeq === undefined || oldestSeq === null) {
    return null;
  }
  const retainedDepth = totalMessages - oldestSeq + 1;
  if (retainedDepth <= 0) {
    return null;
  }
  return oldestSeq > 1
    ? { hasMore: true, nextOffset: retainedDepth, totalMessages }
    : { hasMore: false, totalMessages };
}

function serializedWeight(value: unknown): number | null {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return null;
  }
}

function samePagination(left: ChatHistoryPagination, right: ChatHistoryPagination): boolean {
  if (left.hasMore !== right.hasMore || left.totalMessages !== right.totalMessages) {
    return false;
  }
  if (left.hasMore && right.hasMore) {
    return left.nextOffset === right.nextOffset;
  }
  return !left.hasMore && !right.hasMore && left.completeSnapshot === right.completeSnapshot;
}

function trimChatSessionSnapshotCache(cache: ChatMessageCache): void {
  let weight = 0;
  for (const cached of cache.values()) {
    weight += cached.weight;
  }
  while (weight > MAX_CACHED_CHAT_WEIGHT) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    weight -= cache.get(oldestKey)?.weight ?? 0;
    cache.delete(oldestKey);
  }
}
