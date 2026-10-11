import {
  createSessionProjection,
  readSessionMessageSequence,
  reduceSessionProjection,
} from "@openclaw/gateway-client/browser";
import type { ProgressCard } from "@openclaw/gateway-protocol";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatHistoryCursor, ChatHistoryPagination } from "./chat-history-pagination.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import { getSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";
import type { SessionSnapshotInvalidationReason } from "./session-snapshot-invalidation-events.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

export { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

// JSON code-unit weight bounds retained payloads without allocating another
// UTF-8 buffer on the route-switch path.
const MAX_CACHED_CHAT_SNAPSHOT_WEIGHT = 12 * 1024 * 1024;
export const MAX_CACHED_CHAT_WEIGHT = 24 * 1024 * 1024;
// History reconciliation replaces changed messages and retains unchanged
// objects, so serialization weight can follow the same immutable identity.
const cachedMessageWeights = new WeakMap<object, number>();
const appendedEventClaims = new WeakMap<ChatMessageCache, WeakSet<object>>();

export type ChatTranscriptMetadata = Pick<
  GatewaySessionRow,
  | "key"
  | "kind"
  | "classification"
  | "participants"
  | "expandedParticipants"
  | "owner"
  | "lastRunId"
  | "status"
  | "runtimeMs"
>;

const transcriptMetadata = new WeakMap<GatewaySessionRow, ChatTranscriptMetadata>();

export function projectChatTranscriptMetadata(row: GatewaySessionRow): ChatTranscriptMetadata {
  const existing = transcriptMetadata.get(row);
  if (existing) {
    return existing;
  }
  const {
    key,
    kind,
    classification,
    participants,
    expandedParticipants,
    owner,
    lastRunId,
    status,
    runtimeMs,
  } = row;
  const metadata = {
    key,
    kind,
    classification,
    participants,
    expandedParticipants,
    owner,
    lastRunId,
    status,
    runtimeMs,
  };
  transcriptMetadata.set(row, metadata);
  return metadata;
}

export type ChatSessionSnapshot = {
  widgetHeights?: Record<string, number>;
  transcriptMetadata?: ChatTranscriptMetadata;
  progressCard?: ProgressCard | null;
  deltaCursor?: string;
  displayedLeafEntryId?: string | null;
  messages: unknown[];
  pagination: ChatHistoryPagination;
  sessionId: string | null;
};

export type ChatWidgetLayout = {
  read: (key: string) => number | undefined;
  write: (key: string, height: number) => void;
};

export function createChatWidgetLayout(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): ChatWidgetLayout {
  const cacheKey = resolveChatSnapshotKey(host, target);
  const sessionId = cache.get(cacheKey)?.snapshot.sessionId;
  const current = () => {
    const snapshot = cache.get(cacheKey)?.snapshot;
    return resolveChatSnapshotKey(host, target) === cacheKey && snapshot?.sessionId === sessionId
      ? snapshot
      : undefined;
  };
  return {
    read: (key) => current()?.widgetHeights?.[key],
    write: (key, height) => {
      const snapshot = current();
      if (!snapshot || !Number.isFinite(height) || height < 48 || height > 8000) {
        return;
      }
      if (snapshot.widgetHeights?.[key] === height) {
        return;
      }
      const widgetHeights = { ...snapshot.widgetHeights };
      delete widgetHeights[key];
      widgetHeights[key] = height;
      const keys = Object.keys(widgetHeights);
      if (keys.length > 100) {
        delete widgetHeights[keys[0]!];
      }
      cacheChatSessionSnapshot(cache, host, target, { ...snapshot, widgetHeights });
    },
  };
}

type CachedChatSessionSnapshot = {
  snapshot: ChatSessionSnapshot;
  weight: number;
};

export type ChatMessageCache = Map<string, CachedChatSessionSnapshot>;

export type ChatCacheObserver = {
  delete: (sessionKey: string, reason?: SessionSnapshotInvalidationReason) => void | Promise<void>;
  write: (sessionKey: string, snapshot: ChatSessionSnapshot) => void;
};

const chatCacheObservers = new WeakMap<ChatMessageCache, ChatCacheObserver>();

type ChatMessageCacheHost = Parameters<typeof resolveChatSnapshotKey>[0];
type ChatMessageCacheTarget = Parameters<typeof resolveChatSnapshotKey>[1];

type ChatHistoryCursorHost = ChatMessageCacheHost & {
  sessionKey: string;
  currentSessionId?: string | null;
  chatHistoryCursor?: ChatHistoryCursor;
};

export function readChatHistoryCursor(state: ChatHistoryCursorHost): string | undefined {
  const receipt = state.chatHistoryCursor;
  if (
    receipt?.snapshotKey === resolveChatSnapshotKey(state, { sessionKey: state.sessionKey }) &&
    receipt.sessionId === (state.currentSessionId ?? null)
  ) {
    return receipt.cursor;
  }
  delete state.chatHistoryCursor;
  return undefined;
}

export function setChatHistoryCursor(
  state: ChatHistoryCursorHost,
  cursor: string | undefined,
): void {
  state.chatHistoryCursor =
    cursor === undefined
      ? undefined
      : {
          cursor,
          snapshotKey: resolveChatSnapshotKey(state, { sessionKey: state.sessionKey }),
          sessionId: state.currentSessionId ?? null,
        };
}

export function observeChatCache(cache: ChatMessageCache, observer: ChatCacheObserver): void {
  chatCacheObservers.set(cache, observer);
}

function deleteChatSnapshot(
  cache: ChatMessageCache,
  cacheKey: string,
  reason?: SessionSnapshotInvalidationReason,
): void {
  cache.delete(cacheKey);
  void chatCacheObservers.get(cache)?.delete(cacheKey, reason);
}

export function applyChatCacheSnapshot(
  state: ChatHistoryCursorHost & {
    chatDisplayedLeafEntryId?: string | null;
    chatHistoryPagination: ChatHistoryPagination;
    chatMessages: unknown[];
    currentSessionId?: string | null;
  },
  snapshot: ChatSessionSnapshot,
): void {
  reduceChatSessionProjection(
    state,
    { type: "snapshotLoaded", messages: snapshot.messages },
    {
      scope: readChatSessionProjectionScope(state, {
        sessionId: snapshot.sessionId,
        ...(Object.hasOwn(snapshot, "displayedLeafEntryId")
          ? { activeLeafEntryId: snapshot.displayedLeafEntryId }
          : {}),
      }),
    },
  );
  state.chatHistoryPagination = snapshot.pagination;
  state.currentSessionId = snapshot.sessionId;
  state.chatDisplayedLeafEntryId = snapshot.displayedLeafEntryId;
  setChatHistoryCursor(state, snapshot.deltaCursor);
}

export function appendChatMessageToCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  message: unknown,
  eventClaim?: object,
): void {
  const cacheKey = resolveChatSnapshotKey(host, target);
  const existing = getSessionCacheValue(cache, cacheKey);
  if (!existing) {
    return;
  }
  if (eventClaim) {
    let claims = appendedEventClaims.get(cache);
    if (!claims) {
      claims = new WeakSet();
      appendedEventClaims.set(cache, claims);
    }
    if (claims.has(eventClaim)) {
      return;
    }
    claims.add(eventClaim);
  }
  const messageWeight = serializedArrayItemWeight(message);
  if (messageWeight === null) {
    deleteChatSnapshot(cache, cacheKey, "cache-eviction");
    return;
  }
  const messages = eventClaim
    ? reduceSessionProjection(createSessionProjection({}, existing.snapshot.messages), {
        type: "messagePersisted",
        message,
        envelope: eventClaim,
      }).messages.slice()
    : [...existing.snapshot.messages, message];
  const snapshot = {
    ...existing.snapshot,
    messages,
  };
  if (eventClaim) {
    cacheChatSessionSnapshot(cache, host, target, snapshot);
    return;
  }
  const weight = existing.weight + messageWeight + (existing.snapshot.messages.length > 0 ? 1 : 0);
  if (weight > MAX_CACHED_CHAT_SNAPSHOT_WEIGHT) {
    cacheChatSessionSnapshot(cache, host, target, snapshot);
    return;
  }
  setSessionCacheValue(cache, cacheKey, {
    snapshot,
    weight,
  });
  trimChatSessionSnapshotCache(cache);
  chatCacheObservers.get(cache)?.write(cacheKey, snapshot);
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
  reason?: SessionSnapshotInvalidationReason,
): void {
  deleteChatSnapshot(cache, resolveChatSnapshotKey(host, target), reason);
}

export function cacheChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  incoming: ChatSessionSnapshot,
): void {
  const cacheKey = resolveChatSnapshotKey(host, target);
  const existing = getSessionCacheValue(cache, cacheKey);
  // History prefetch owns transcript facts, not the independently refreshed card.
  const withProgress =
    incoming.progressCard === undefined &&
    existing?.snapshot.progressCard !== undefined &&
    existing.snapshot.sessionId === incoming.sessionId
      ? { ...incoming, progressCard: existing.snapshot.progressCard }
      : incoming;
  const snapshot =
    withProgress.widgetHeights === undefined && existing?.snapshot.sessionId === incoming.sessionId
      ? { ...withProgress, widgetHeights: existing.snapshot.widgetHeights }
      : withProgress;
  if (
    existing?.snapshot.messages === snapshot.messages &&
    existing.snapshot.deltaCursor === snapshot.deltaCursor &&
    existing.snapshot.sessionId === snapshot.sessionId &&
    existing.snapshot.displayedLeafEntryId === snapshot.displayedLeafEntryId &&
    existing.snapshot.transcriptMetadata === snapshot.transcriptMetadata &&
    existing.snapshot.progressCard === snapshot.progressCard &&
    existing.snapshot.widgetHeights === snapshot.widgetHeights &&
    samePagination(existing.snapshot.pagination, snapshot.pagination)
  ) {
    return;
  }
  if (
    snapshot.messages.length === 0 &&
    snapshot.sessionId === null &&
    !snapshot.pagination.hasMore &&
    (snapshot.pagination.totalMessages ?? 0) === 0 &&
    snapshot.pagination.completeSnapshot !== true
  ) {
    deleteChatSnapshot(cache, cacheKey, "cache-eviction");
    return;
  }
  const bounded = boundChatSessionSnapshot(snapshot);
  if (!bounded) {
    deleteChatSnapshot(cache, cacheKey, "cache-eviction");
    return;
  }
  setSessionCacheValue(cache, cacheKey, bounded);
  trimChatSessionSnapshotCache(cache);
  chatCacheObservers.get(cache)?.write(cacheKey, bounded.snapshot);
}

export function readChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): ChatSessionSnapshot | null {
  return getSessionCacheValue(cache, resolveChatSnapshotKey(host, target))?.snapshot ?? null;
}

function boundChatSessionSnapshot(snapshot: ChatSessionSnapshot): CachedChatSessionSnapshot | null {
  const messageWeights: number[] = [];
  for (const message of snapshot.messages) {
    const weight = serializedArrayItemWeight(message);
    if (weight === null) {
      return null;
    }
    messageWeights.push(weight);
  }
  let retainedMessageWeight = messageWeights.reduce((sum, weight) => sum + weight, 0);
  let start = 0;
  while (true) {
    const pagination =
      start === 0
        ? snapshot.pagination
        : capSnapshotPagination(snapshot.pagination, snapshot.messages, start);
    if (!pagination) {
      return null;
    }
    const envelope = { ...snapshot, messages: [], pagination };
    let weight: number | null;
    try {
      const envelopeWeight = JSON.stringify(envelope)?.length ?? 0;
      weight =
        envelopeWeight + retainedMessageWeight + Math.max(0, messageWeights.length - start - 1);
    } catch {
      weight = null;
    }
    if (weight !== null && weight <= MAX_CACHED_CHAT_SNAPSHOT_WEIGHT) {
      if (start === 0) {
        return { snapshot, weight };
      }
      return {
        snapshot: {
          ...snapshot,
          messages: snapshot.messages.slice(start),
          pagination: { ...pagination },
        },
        weight,
      };
    }
    if (start >= snapshot.messages.length) {
      return null;
    }
    const boundarySeq = readSessionMessageSequence(snapshot.messages[start]);
    do {
      retainedMessageWeight -= messageWeights[start] ?? 0;
      start += 1;
      if (boundarySeq === null) {
        break;
      }
    } while (
      start < snapshot.messages.length &&
      readSessionMessageSequence(snapshot.messages[start]) === boundarySeq
    );
  }
}

function serializedArrayItemWeight(value: unknown): number | null {
  if (value && typeof value === "object") {
    const cached = cachedMessageWeights.get(value);
    if (cached !== undefined) {
      return cached;
    }
  }
  try {
    const serialized = JSON.stringify([value]);
    const weight = serialized ? Math.max(0, serialized.length - 2) : 0;
    if (value && typeof value === "object") {
      cachedMessageWeights.set(value, weight);
    }
    return weight;
  } catch {
    return null;
  }
}

function capSnapshotPagination(
  pagination: ChatHistoryPagination,
  messages: unknown[],
  start = 0,
): ChatHistoryPagination | null {
  const totalMessages = pagination.totalMessages;
  let oldestSeq: number | null = null;
  for (let index = start; index < messages.length; index += 1) {
    oldestSeq = readSessionMessageSequence(messages[index]);
    if (oldestSeq !== null) {
      break;
    }
  }
  if (typeof totalMessages !== "number" || oldestSeq === null) {
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
