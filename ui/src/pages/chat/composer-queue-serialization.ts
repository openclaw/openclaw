import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  normalizeStoredQueueItem,
  sameQueuedDeliveryVersion,
} from "../../lib/chat/outbox-store-codec.ts";
import {
  applyStoredChatOutboxScope,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

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
