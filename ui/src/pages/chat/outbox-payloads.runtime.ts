import { readBlobAsDataUrl } from "../../lib/blob-data-url.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  outboxPayloadTab,
  readOutboxPayload,
  removeOutboxPayloads,
  writeOutboxPayload,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import { captureDurableChatAttachments } from "./durable-composer-persistence.ts";
import type { PayloadResult } from "./outbox-payloads.ts";

export async function prepareCapturedOutboxPayload(
  item: ChatQueueItem,
  purpose: "send" | "handoff",
  gatewayOwner: string,
  recoveryScope: string,
  isCurrent: () => boolean,
): Promise<PayloadResult> {
  if (!isCurrent()) {
    return { status: "failed", reason: "unavailable" };
  }
  let tabId: string;
  try {
    tabId = await outboxPayloadTab();
  } catch {
    return { status: "failed", reason: "unavailable" };
  }
  if (!isCurrent()) {
    return { status: "failed", reason: "unavailable" };
  }
  const owner = {
    tabId,
    gatewayOwner,
    recoveryScope,
    queueId: item.id,
  };
  if (item.attachmentPayload) {
    const result = await readOutboxPayload(owner, item.attachmentPayload);
    if (result.status === "failed") {
      return result;
    }
    const metadata = item.attachments ?? [];
    if (
      result.value.length !== metadata.length ||
      result.value.some((attachment, index) => {
        const expected = metadata[index]!;
        return (
          attachment.mimeType !== expected.mimeType ||
          attachment.fileName !== expected.fileName ||
          attachment.origin !== expected.origin ||
          attachment.sizeBytes !== expected.sizeBytes
        );
      })
    ) {
      return { status: "failed", reason: "missing" };
    }
    if (!isCurrent()) {
      return { status: "failed", reason: "unavailable" };
    }
    try {
      // Restore into isolated objects; no consumer sees a partially hydrated batch.
      const attachments = await Promise.all(
        result.value.map(async (attachment, index) => ({
          ...metadata[index]!,
          ...(attachment.selectionAnnotation
            ? { selectionAnnotation: attachment.selectionAnnotation }
            : {}),
          dataUrl: await readBlobAsDataUrl(attachment.blob),
        })),
      );
      if (!isCurrent()) {
        return { status: "failed", reason: "unavailable" };
      }
      const update = {
        attachments,
        attachmentPayload: item.attachmentPayload,
        attachmentStorageError: undefined,
      };
      if (purpose === "send" && item.attachmentPayload.tabId !== tabId) {
        const copy = await writeOutboxPayload(owner, result.value);
        if (copy.status === "failed") {
          return copy;
        }
        if (!isCurrent()) {
          await removeOutboxPayloads([copy.value]);
          return { status: "failed", reason: "unavailable" };
        }
        // A duplicate tab keeps the original submission ID; server admission
        // deduplicates its retry while each tab owns its attachment bytes.
        return {
          status: "ready",
          update: {
            ...update,
            attachmentPayload: copy.value,
          },
        };
      }
      return { status: "ready", update };
    } catch {
      return { status: "failed", reason: "missing" };
    }
  }
  // Delivery already happened: read existing bytes, never allocate a new bundle.
  if (purpose === "handoff" || item.attachmentStorageError === "missing") {
    return { status: "failed", reason: "missing" };
  }
  const attachments = captureDurableChatAttachments(item.attachments ?? []);
  if (!attachments) {
    return { status: "failed", reason: "missing" };
  }
  const result = await writeOutboxPayload(owner, attachments);
  if (result.status === "failed") {
    return result;
  }
  if (!isCurrent()) {
    await removeOutboxPayloads([result.value]);
    return { status: "failed", reason: "unavailable" };
  }
  return {
    status: "ready",
    update: { attachmentPayload: result.value, attachmentStorageError: undefined },
  };
}
