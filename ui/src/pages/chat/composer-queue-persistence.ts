import { readOfflineStorageScope } from "../../app/boot-record.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  outboxPayloadMatchesOwner,
  outboxStorageScope,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  MAX_STORED_QUEUE_ITEMS,
  normalizeStoredQueueItem,
  sameQueuedDeliveryVersion,
  type StoredComposerSession,
} from "../../lib/chat/outbox-store-codec.ts";
import {
  storedChatOutboxScopeKey,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store-scope.ts";
import {
  applyStoredChatOutboxScope,
  notifyStoredChatOutboxChanges,
  readStoredOutboxStore as readStore,
  resolvePendingComposerSessions,
  storageTargetForComposer,
  writeStoredOutboxStore as writeStore,
  type captureChatOutboxAdmission,
  type ChatComposerScope,
  type StoredComposerState,
} from "../../lib/chat/outbox-store.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

export type StoredChatQueueReplacement = {
  id: string;
  expected: ChatQueueItem;
};

function writeStoredComposerSession(
  store: StoredComposerState,
  storeSessionKey: string,
  session: StoredComposerSession | null,
  queue: ChatQueueItem[],
): void {
  if (
    !session?.draft &&
    !session?.goalMode &&
    !session?.replyTarget &&
    session?.draftRevision === undefined &&
    queue.length === 0
  ) {
    delete store.sessions[storeSessionKey];
    return;
  }
  const { queue: _queue, updatedAt: _updatedAt, ...draft } = session ?? {};
  store.sessions[storeSessionKey] = {
    ...draft,
    ...(queue.length ? { queue } : {}),
    updatedAt: Date.now(),
  };
}

export function serializeQueueItemForScope(
  item: ChatQueueItem,
  scope: StoredChatOutboxScope,
): ChatQueueItem | null {
  if (
    !item.id?.trim() ||
    (!item.text?.trim() &&
      !item.attachments?.length &&
      !item.attachmentPayload &&
      !item.attachmentStorageError) ||
    item.pendingRunId ||
    (item.sendState === "sending" && !item.sendRunId)
  ) {
    return null;
  }
  const attachments = (item.attachments ?? []).map((attachment) => {
    const { dataUrl: _dataUrl, previewUrl: _previewUrl, ...metadata } = attachment;
    // A failed migration owns no Blob yet: retain its inline bytes across reload.
    // Only a payload reference permits removing bytes from the stored queue row.
    if (item.attachmentPayload) {
      return metadata;
    }
    const dataUrl = getChatAttachmentDataUrl(attachment);
    if (dataUrl) {
      return Object.assign(metadata, { dataUrl });
    }
    return item.attachmentStorageError ? metadata : null;
  });
  if (item.attachments?.length && attachments.some((attachment) => attachment === null)) {
    return null;
  }
  const serialized = normalizeStoredQueueItem({
    ...item,
    attachments: attachments.length ? attachments : undefined,
    ...(item.sendState === "waiting-model" ? { sendError: INTERRUPTED_SETTINGS_WAIT_ERROR } : {}),
  });
  return serialized ? applyStoredChatOutboxScope(serialized, scope) : null;
}

function queueItemVersionMatches(
  stored: ChatQueueItem,
  expected: ChatQueueItem,
  scope: StoredChatOutboxScope,
): boolean {
  const canonicalExpected = serializeQueueItemForScope(expected, scope);
  return Boolean(canonicalExpected && sameQueuedDeliveryVersion(stored, canonicalExpected));
}

function queueItemsEqual(
  stored: ChatQueueItem,
  canonicalExpected: ChatQueueItem,
  scope: StoredChatOutboxScope,
): boolean {
  const canonicalStored = serializeQueueItemForScope(stored, scope);
  return Boolean(
    canonicalStored && JSON.stringify(canonicalStored) === JSON.stringify(canonicalExpected),
  );
}

export type ChatQueueAdmissionResult = "admitted" | "source-changed" | "full" | "storage-failed";

export function admitStoredChatComposerQueueItemResult(
  state: ChatComposerScope,
  captured: ReturnType<typeof captureChatOutboxAdmission>,
  item: ChatQueueItem,
  replaces?: StoredChatQueueReplacement,
): ChatQueueAdmissionResult {
  const storage = getSafeSessionStorage();
  if (
    !storage ||
    !captured.scope.sessionKey.trim() ||
    captured.owner !== readOfflineStorageScope(state) ||
    captured.gatewayOwner !== storageTargetForComposer(state).gatewayOwner
  ) {
    return "storage-failed";
  }
  try {
    const target = storageTargetForComposer(state);
    const store = readStore(storage, target);
    const scope = captured.scope;
    const owned = { ...item, storageScope: item.storageScope ?? outboxStorageScope(state) };
    const serialized = outboxPayloadMatchesOwner(state, owned)
      ? serializeQueueItemForScope(owned, scope)
      : null;
    if (!serialized) {
      return "storage-failed";
    }
    const migrated = resolvePendingComposerSessions(store, state);
    const storeSessionKey = storedChatOutboxScopeKey(scope);
    const session = store.sessions[storeSessionKey] ?? null;
    // An edited row and its replacement are one write: the source is retired only
    // by the write that stores the replacement, so a rejected write leaves the
    // original queued instead of losing both copies. Filtering before the cap
    // check also keeps a replacement admissible on a full queue.
    const storedQueue = session?.queue ?? [];
    if (
      replaces &&
      !storedQueue.some(
        (entry) =>
          entry.id === replaces.id && queueItemVersionMatches(entry, replaces.expected, scope),
      )
    ) {
      return "source-changed";
    }
    const queue = storedQueue.filter((entry) => entry.id !== replaces?.id);
    const existing = queue.find((entry) => entry.id === serialized.id);
    if (existing) {
      if (!queueItemsEqual(existing, serialized, scope)) {
        return "storage-failed";
      }
      if (migrated) {
        writeStore(storage, target, store);
        notifyStoredChatOutboxChanges();
      }
      return "admitted";
    }
    if (queue.length >= MAX_STORED_QUEUE_ITEMS) {
      return "full";
    }
    writeStoredComposerSession(store, storeSessionKey, session, [...queue, serialized]);
    if (captured.awaitingDefaults) {
      store.sessions[storeSessionKey]!.awaitingDefaults = true;
    }
    writeStore(storage, target, store);
    const persisted = readStore(storage, target).sessions[storeSessionKey]?.queue?.find(
      (entry) => entry.id === serialized.id,
    );
    // Verify the captured write before subscribers can change defaults or drain it.
    const admitted = Boolean(persisted && queueItemsEqual(persisted, serialized, scope));
    notifyStoredChatOutboxChanges();
    return admitted ? "admitted" : "storage-failed";
  } catch {
    return "storage-failed";
  }
}

/**
 * Batch compare-and-set for durable queue rows. A caller passing several rows
 * (a reorder permutation) gets one fresh read, one validation pass over every
 * expected row, one full-document write, and one read-back verification — so
 * the whole set commits or none of it does. A mid-batch storage failure can
 * never leave a permutation half-applied the way a per-row write loop would.
 * A null next row removes it; removing an absent row is a no-op.
 */
export function updateStoredChatComposerQueueItems(
  state: ChatComposerScope,
  sessionKey: string,
  updates: readonly { expected: ChatQueueItem; next: ChatQueueItem | null }[],
  agentId?: string,
): boolean {
  if (updates.length === 0) {
    return true;
  }
  const storage = getSafeSessionStorage();
  if (
    !storage ||
    !sessionKey.trim() ||
    updates.some(({ expected, next }) => (next ? expected.id !== next.id : !expected.id.trim()))
  ) {
    return false;
  }
  try {
    const target = storageTargetForComposer(state);
    const store = readStore(storage, target);
    const scope = {
      sessionKey,
      agentId: agentId ?? updates[0]!.expected.agentId ?? updates[0]!.next?.agentId,
    };
    const storeSessionKey = storedChatOutboxScopeKey(scope);
    const session = store.sessions[storeSessionKey] ?? null;
    const nextQueue = (session?.queue ?? []).slice();
    let changed = false;
    for (const { expected, next } of updates) {
      const index = nextQueue.findIndex((entry) => entry.id === expected.id);
      if (index < 0 && next === null) {
        continue;
      }
      // A missing or stale row rejects the whole batch before anything is written.
      if (index < 0 || !queueItemVersionMatches(nextQueue[index]!, expected, scope)) {
        return false;
      }
      if (next === null) {
        nextQueue.splice(index, 1);
      } else {
        const serializedNext = serializeQueueItemForScope(next, scope);
        if (!serializedNext) {
          return false;
        }
        nextQueue[index] = serializedNext;
      }
      changed = true;
    }
    if (!changed) {
      return true;
    }
    writeStoredComposerSession(store, storeSessionKey, session, nextQueue);
    writeStore(storage, target, store);
    notifyStoredChatOutboxChanges();
    const persistedQueue = readStore(storage, target).sessions[storeSessionKey]?.queue ?? [];
    return updates.every(({ expected, next }) => {
      const persisted = persistedQueue.find((entry) => entry.id === expected.id);
      if (next === null) {
        return !persisted;
      }
      const serializedNext = serializeQueueItemForScope(next, scope);
      return Boolean(
        persisted && serializedNext && queueItemsEqual(persisted, serializedNext, scope),
      );
    });
  } catch {
    return false;
  }
}
