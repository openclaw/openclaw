import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  normalizeStoredQueueItem,
  sameQueuedDeliveryVersion,
  type StoredComposerSession,
} from "../../lib/chat/outbox-store-codec.ts";
import {
  applyStoredChatOutboxScope,
  type StoredChatOutboxScope,
  type StoredComposerState,
} from "../../lib/chat/outbox-store.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

export function writeStoredComposerSession(
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
  store.sessions[storeSessionKey] = {
    ...(session?.awaitingDefaults ? { awaitingDefaults: true } : {}),
    ...(session?.draft ? { draft: session.draft } : {}),
    ...(session?.draftMentions ? { draftMentions: session.draftMentions } : {}),
    ...(session?.goalMode ? { goalMode: session.goalMode } : {}),
    ...(session?.replyTarget ? { replyTarget: session.replyTarget } : {}),
    ...(session?.draftRevision !== undefined ? { draftRevision: session.draftRevision } : {}),
    ...(queue.length ? { queue } : {}),
    updatedAt: Date.now(),
  };
}

function serializeQueueItem(item: ChatQueueItem): ChatQueueItem | null {
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
  return normalizeStoredQueueItem({
    ...item,
    attachments: attachments.length ? attachments : undefined,
    ...(item.sendState === "waiting-model" ? { sendError: INTERRUPTED_SETTINGS_WAIT_ERROR } : {}),
  });
}

export function serializeQueueItemForScope(
  item: ChatQueueItem,
  scope: StoredChatOutboxScope,
): ChatQueueItem | null {
  const serialized = serializeQueueItem(item);
  if (!serialized) {
    return null;
  }
  return applyStoredChatOutboxScope(serialized, scope);
}

export function queueItemVersionMatches(
  stored: ChatQueueItem,
  expected: ChatQueueItem,
  scope: StoredChatOutboxScope,
): boolean {
  const canonicalExpected = serializeQueueItemForScope(expected, scope);
  return Boolean(canonicalExpected && sameQueuedDeliveryVersion(stored, canonicalExpected));
}

export function queueItemsEqual(
  stored: ChatQueueItem,
  canonicalExpected: ChatQueueItem,
  scope: StoredChatOutboxScope,
): boolean {
  const canonicalStored = serializeQueueItemForScope(stored, scope);
  return Boolean(
    canonicalStored && JSON.stringify(canonicalStored) === JSON.stringify(canonicalExpected),
  );
}
