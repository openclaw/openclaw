import {
  createSessionProjection,
  readSessionMessageSequence,
  reduceSessionProjection,
} from "@openclaw/gateway-client/browser";
import type { MessageReactionSummary, ProgressCard } from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import type { GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ChatFastModePresentation } from "../../lib/chat/model-select-state.ts";
import { readPairingQrContent } from "../../lib/chat/pairing-qr.ts";
import {
  chatDisplaySourceKey,
  MAX_CHAT_THUMBNAILS,
  MAX_CHAT_THUMBNAIL_BYTES,
  type ChatDisplayFacts,
  type ChatRowDisplayFacts,
} from "../../lib/chat/row-display-facts.ts";
import type { ChatHistoryCursor, ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { ChatSessionStateSnapshot } from "./chat-session-state-snapshot.ts";
import type { ChatHistoryState, ChatTranscriptMetadata } from "./chat-transcript-metadata.ts";
import { createTranscriptMemo } from "./components/chat-transcript-memo.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import { getSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";
import { boundChatThumbnails, projectChatRowDisplay } from "./session-message-display-facts.ts";
import type { SessionSnapshotInvalidationReason } from "./session-snapshot-invalidation-events.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

export { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

// JSON code-unit weight bounds retained payloads without allocating another
// UTF-8 buffer on the route-switch path.
export const MAX_CACHED_CHAT_SNAPSHOT_WEIGHT = 12 * 1024 * 1024;
export const MAX_CACHED_CHAT_WEIGHT = 24 * 1024 * 1024;
// History reconciliation replaces changed messages and retains unchanged
// objects, so serialization weight can follow the same immutable identity.
const cachedMessageWeights = new WeakMap<object, number>();
const appendedEventClaims = new WeakMap<ChatMessageCache, WeakSet<object>>();

const transcriptMetadata = new WeakMap<GatewaySessionRow, ChatTranscriptMetadata>();
const avatarMaps = new WeakMap<Record<string, string | null>, ReadonlyMap<string, string | null>>();

export function projectChatAvatarSources(sources: Record<string, string | null> | undefined) {
  if (!sources) {
    return undefined;
  }
  let avatars = avatarMaps.get(sources);
  if (!avatars) {
    avatars = new Map(Object.entries(sources));
    avatarMaps.set(sources, avatars);
  }
  return avatars;
}

export function projectChatTranscriptMetadata(row: GatewaySessionRow): ChatTranscriptMetadata {
  const existing = transcriptMetadata.get(row);
  if (existing) {
    return existing;
  }
  const metadata = {
    key: row.key,
    kind: row.kind,
    label: row.label,
    displayName: row.displayName,
    derivedTitle: row.derivedTitle,
    classification: row.classification,
    participants: row.participants,
    expandedParticipants: row.expandedParticipants,
    owner: row.owner,
    lastRunId: row.lastRunId,
    status: row.status,
    runtimeMs: row.runtimeMs,
    contextTokens: row.contextTokens,
    sessionId: row.sessionId,
    archived: row.archived,
    archivedAt: row.archivedAt,
    archivedBy: row.archivedBy,
    archiveReason: row.archiveReason,
  };
  transcriptMetadata.set(row, metadata);
  return metadata;
}

// Display only: the live catalog and session owners still admit every action.
export type ChatComposerSnapshot = Pick<
  ModelCatalogEntry,
  "id" | "provider" | "name" | "reasoning"
> &
  Pick<
    GatewaySessionRow,
    "thinkingLevel" | "thinkingLevels" | "thinkingDefault" | "permissionMode"
  > & {
    defaultPermissionMode?: GatewaySessionRow["permissionMode"];
    speed?: ChatFastModePresentation;
  };

export type ChatSessionSnapshot = {
  sessionState?: ChatSessionStateSnapshot;
  rowDisplay?: Record<string, ChatRowDisplayFacts>;
  avatarSources?: Record<string, string | null>;
  composer?: ChatComposerSnapshot | null;
  // The board provider validates cached payloads before they can reach a view.
  board?: { snapshot: unknown; receivedAtMs: number } | null;
  widgetHeights?: Record<string, number>;
  transcriptMetadata?: ChatTranscriptMetadata;
  messageReactions?: Record<string, MessageReactionSummary[]>;
  progressCard?: ProgressCard | null;
  deltaCursor?: string;
  historyState?: ChatHistoryState;
  displayedLeafEntryId?: string | null;
  messages: unknown[];
  pagination: ChatHistoryPagination;
  sessionId: string | null;
};

export function cacheChatAvatarSource(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  agentId: string,
  source: string | null,
): void {
  const snapshot = readChatSessionSnapshot(cache, host, target);
  if (!snapshot || agentId.length > 256 || (source && !chatDisplaySourceKey(source))) {
    return;
  }
  if (snapshot.avatarSources?.[agentId] === source) {
    return;
  }
  const sources = new Map(Object.entries(snapshot.avatarSources ?? {}));
  sources.delete(agentId);
  sources.set(agentId, source);
  if (sources.size > 24) {
    sources.delete(sources.keys().next().value!);
  }
  cacheChatSessionSnapshot(cache, host, target, {
    ...snapshot,
    avatarSources: Object.fromEntries(sources),
  });
}

export function createChatDisplayFacts(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): ChatDisplayFacts {
  const key = resolveChatSnapshotKey(host, target);
  let sessionId = cache.get(key)?.snapshot.sessionId;
  const current = () => {
    const snapshot = cache.get(key)?.snapshot;
    if (sessionId === undefined && snapshot) {
      sessionId = snapshot.sessionId;
    }
    return resolveChatSnapshotKey(host, target) === key && snapshot?.sessionId === sessionId
      ? snapshot
      : undefined;
  };
  return {
    forRow(messageId) {
      if (!messageId) {
        return undefined;
      }
      return {
        read: () => current()?.rowDisplay?.[messageId],
        write(update) {
          const snapshot = current();
          if (!snapshot) {
            return;
          }
          const previous = snapshot.rowDisplay?.[messageId];
          const row = { ...previous, ...update };
          if (
            Object.keys(row.links ?? {}).length > 8 ||
            Object.keys(row.images ?? {}).length > 8 ||
            JSON.stringify(row).length > 8192 ||
            Object.entries(row.links ?? {}).some(
              ([key, value]) =>
                key.length > 4096 ||
                (value.title?.length ?? 0) > 256 ||
                (value.badge?.label.length ?? 0) > 256,
            ) ||
            Object.entries(row.images ?? {}).some(
              ([key, value]) =>
                key.length > 4096 ||
                !Number.isSafeInteger(value.width) ||
                !Number.isSafeInteger(value.height) ||
                value.width <= 0 ||
                value.width > 100_000 ||
                value.height <= 0 ||
                value.height > 100_000,
            )
          ) {
            return;
          }
          cacheChatSessionSnapshot(cache, host, target, {
            ...snapshot,
            rowDisplay: { ...snapshot.rowDisplay, [messageId]: row },
          });
        },
      };
    },
  };
}

export type ChatWidgetLayout = {
  read: (key: string) => number | undefined;
  readRows: () => Readonly<Record<string, number>> | undefined;
  write: (key: string, size: number | null, row?: string, settled?: boolean) => number | undefined;
  writeRows: (heights: Record<string, number>) => void;
  invalidateRow: (rowKey: string | undefined) => void;
};

function captureWidgetLayoutReservation(snapshot: ChatSessionSnapshot | undefined) {
  return snapshot && { sessionId: snapshot.sessionId, widgetHeights: snapshot.widgetHeights };
}

export function createChatWidgetLayout() {
  const layouts = createTranscriptMemo<ChatWidgetLayout>();
  return (
    cache: ChatMessageCache,
    host: ChatMessageCacheHost & { currentSessionId?: string | null },
    target: ChatMessageCacheTarget,
  ): ChatWidgetLayout =>
    layouts(cache, [resolveChatSnapshotKey(host, target), host.currentSessionId], () => {
      const [rowRevision, setRowRevision] = createSignal(0);
      const cacheKey = resolveChatSnapshotKey(host, target);
      // Reserve admitted geometry until reload without retaining replaceable message bodies.
      let admitted = captureWidgetLayoutReservation(cache.get(cacheKey)?.snapshot);
      const current = () => {
        const snapshot =
          resolveChatSnapshotKey(host, target) === cacheKey
            ? cache.get(cacheKey)?.snapshot
            : undefined;
        admitted ??= captureWidgetLayoutReservation(snapshot);
        return snapshot?.sessionId === admitted?.sessionId ? snapshot : undefined;
      };
      const writeHeights = (heights: Record<string, number>) => {
        const snapshot = current();
        if (
          !snapshot ||
          Object.entries(heights).every(([key, size]) => snapshot.widgetHeights?.[key] === size)
        ) {
          return;
        }
        const widgetHeights = Object.fromEntries(
          [
            ...Object.entries(snapshot.widgetHeights ?? {}).filter(([key]) => !(key in heights)),
            ...Object.entries(heights),
          ].slice(-100),
        );
        cacheChatSessionSnapshot(cache, host, target, { ...snapshot, widgetHeights });
      };
      const invalidateRow = (rowKey: string | undefined, widgetKey?: string) => {
        const snapshot = current();
        if (!snapshot || (!rowKey && !widgetKey)) {
          return;
        }
        const retain = ([key]: [string, number]) =>
          key !== widgetKey &&
          !(key.startsWith("row:v1:") && key.endsWith(`:${JSON.stringify(rowKey)}`));
        if (!widgetKey && Object.entries(admitted?.widgetHeights ?? {}).every(retain)) {
          return;
        }
        const prune = (heights: typeof snapshot.widgetHeights) =>
          Object.fromEntries(Object.entries(heights ?? {}).filter(retain));
        admitted = { sessionId: snapshot.sessionId, widgetHeights: prune(admitted?.widgetHeights) };
        const widgetHeights = widgetKey ? prune(snapshot.widgetHeights) : snapshot.widgetHeights;
        cacheChatSessionSnapshot(cache, host, target, { ...snapshot, widgetHeights });
        setRowRevision((revision) => revision + 1);
      };
      return {
        read: (key) => {
          rowRevision();
          const snapshot = current();
          const heights = (key.startsWith("row:v1:") ? admitted : snapshot)?.widgetHeights;
          return snapshot && (heights?.[key] ?? admitted?.widgetHeights?.[key]);
        },
        readRows: () => {
          rowRevision();
          return current() ? admitted?.widgetHeights : undefined;
        },
        write: (key, measuredHeight, rowKey, settled = false) => {
          const snapshot = current();
          if (measuredHeight === null) {
            invalidateRow(rowKey, key);
            return undefined;
          }
          const row = key.startsWith("row:v1:");
          const floor = row || (rowKey && !settled) ? admitted?.widgetHeights?.[key] : 0;
          const height = Math.max(measuredHeight, floor ?? 0);
          if (!snapshot || !Number.isFinite(height) || height < (row ? 1 : 48) || height > 8000) {
            return undefined;
          }
          writeHeights({ [key]: height });
          if (settled) {
            invalidateRow(rowKey);
            if (admitted?.widgetHeights?.[key] !== undefined) {
              admitted.widgetHeights[key] = height;
            }
          }
          return height;
        },
        writeRows: writeHeights,
        invalidateRow,
      };
    });
}

type CachedChatSessionSnapshot = {
  snapshot: ChatSessionSnapshot;
  weight: number;
};

export type ChatMessageCache = Map<string, CachedChatSessionSnapshot>;

/** Disk snapshots omit pairing secrets; discard only their connection-owned memory copies. */
export function retireCachedPairingQr(cache: ChatMessageCache | undefined): void {
  for (const [key, cached] of cache ?? []) {
    if (cached.snapshot.messages.some((message) => readPairingQrContent(message).length > 0)) {
      cache?.delete(key);
    }
  }
}

export type ChatCacheObserver = {
  delete: (sessionKey: string, reason?: SessionSnapshotInvalidationReason) => void | Promise<void>;
  write: (sessionKey: string, snapshot: ChatSessionSnapshot, weight: number) => void;
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

export function readChatHistoryState(
  state: ChatHistoryCursorHost & { chatMessagesBySession?: ChatMessageCache },
  cursor: string | undefined,
): ChatHistoryState | undefined {
  if (cursor === undefined || !state.currentSessionId || !state.chatMessagesBySession) {
    return undefined;
  }
  const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey: state.sessionKey,
  });
  return snapshot?.sessionId === state.currentSessionId ? snapshot.historyState : undefined;
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
  const final = cache.get(cacheKey);
  if (final) {
    chatCacheObservers.get(cache)?.write(cacheKey, final.snapshot, final.weight);
  }
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
  const retained =
    existing?.snapshot.sessionId === incoming.sessionId ? existing.snapshot : undefined;
  // History refreshes preserve independently recorded display facts. Boards belong
  // to the scoped conversation even when its transcript incarnation changes.
  const snapshot = existing
    ? {
        ...incoming,
        sessionState: incoming.sessionState ?? retained?.sessionState,
        rowDisplay: incoming.rowDisplay ?? retained?.rowDisplay,
        avatarSources: incoming.avatarSources ?? retained?.avatarSources,
        messageReactions: incoming.messageReactions ?? retained?.messageReactions,
        widgetHeights: incoming.widgetHeights ?? retained?.widgetHeights,
        progressCard:
          incoming.progressCard === undefined ? retained?.progressCard : incoming.progressCard,
        composer: incoming.composer === undefined ? retained?.composer : incoming.composer,
        board: incoming.board === undefined ? existing.snapshot.board : incoming.board,
      }
    : incoming;
  const previousState = existing?.snapshot.sessionState;
  const sessionState = snapshot.sessionState;
  if (
    existing?.snapshot.messages === snapshot.messages &&
    existing.snapshot.deltaCursor === snapshot.deltaCursor &&
    existing.snapshot.historyState === snapshot.historyState &&
    existing.snapshot.sessionId === snapshot.sessionId &&
    existing.snapshot.displayedLeafEntryId === snapshot.displayedLeafEntryId &&
    existing.snapshot.transcriptMetadata === snapshot.transcriptMetadata &&
    existing.snapshot.messageReactions === snapshot.messageReactions &&
    existing.snapshot.progressCard === snapshot.progressCard &&
    existing.snapshot.widgetHeights === snapshot.widgetHeights &&
    existing.snapshot.board === snapshot.board &&
    existing.snapshot.composer === snapshot.composer &&
    (previousState === sessionState ||
      (previousState?.archived === sessionState?.archived &&
        previousState?.visibility === sessionState?.visibility &&
        previousState?.sharingRole === sessionState?.sharingRole &&
        previousState?.unarchiveAllowed === sessionState?.unarchiveAllowed &&
        previousState?.parentSession === sessionState?.parentSession)) &&
    existing.snapshot.rowDisplay === snapshot.rowDisplay &&
    existing.snapshot.avatarSources === snapshot.avatarSources &&
    samePagination(existing.snapshot.pagination, snapshot.pagination)
  ) {
    return;
  }
  if (
    snapshot.messages.length === 0 &&
    snapshot.sessionId === null &&
    snapshot.board === undefined &&
    snapshot.composer === undefined &&
    !snapshot.pagination.hasMore &&
    (snapshot.pagination.totalMessages ?? 0) === 0 &&
    snapshot.pagination.completeSnapshot !== true
  ) {
    deleteChatSnapshot(cache, cacheKey, "cache-eviction");
    return;
  }
  const rowDisplay = projectChatRowDisplay(snapshot);
  const bounded = boundChatSessionSnapshot(
    rowDisplay === snapshot.rowDisplay ? snapshot : { ...snapshot, rowDisplay },
  );
  if (!bounded) {
    deleteChatSnapshot(cache, cacheKey, "cache-eviction");
    return;
  }
  setSessionCacheValue(cache, cacheKey, bounded);
  trimChatSessionSnapshotCache(cache);
  const final = cache.get(cacheKey);
  if (final) {
    chatCacheObservers.get(cache)?.write(cacheKey, final.snapshot, final.weight);
  }
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
          rowDisplay: projectChatRowDisplay({
            ...snapshot,
            messages: snapshot.messages.slice(start),
          }),
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
  const budget = { count: MAX_CHAT_THUMBNAILS, bytes: MAX_CHAT_THUMBNAIL_BYTES };
  for (const [key, cached] of [...cache].toReversed()) {
    const snapshot = boundChatThumbnails(cached.snapshot, budget);
    if (snapshot !== cached.snapshot) {
      const bounded = boundChatSessionSnapshot(snapshot);
      if (bounded) {
        cache.set(key, bounded);
        chatCacheObservers.get(cache)?.write(key, bounded.snapshot, bounded.weight);
      }
    }
  }
}
