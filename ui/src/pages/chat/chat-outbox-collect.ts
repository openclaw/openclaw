import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxPayloadTab } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import type { StoredChatOutbox } from "../../lib/chat/outbox-store-projection.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { readChatOutboxLane } from "./chat-outbox-scopes.ts";
import { readCollectClient } from "./chat-queue-preference.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatSendHoldReason } from "./chat-send-support.ts";
import { attachmentBatchRejection } from "./components/chat-attachment-admission.ts";
import { updateStoredChatComposerQueueItems } from "./composer-queue-persistence.ts";
import { prepareOutboxPayload, retireOutboxPayload } from "./outbox-payloads.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";

const MAX_MEMBERS = 8;
const MAX_TEXT_BYTES = 16_000;

type CollectMember = {
  id: string;
  text: string;
  images: { position: number; name?: string }[];
};

function serializeMembers(members: CollectMember[]): string {
  return `[Queued WebChat messages, in order; image positions are one-based among attached images]\n${JSON.stringify(members)}`;
}

/**
 * The capsule is one regular chat.send with the first member's admission key.
 * Replacing its storage representation must preserve all member IDs, text and
 * images. Only ordinary receipt handling retires the capsule after admission.
 */
export async function stageQueuedBatch(
  host: ChatHost,
  outbox: StoredChatOutbox,
  head: ChatQueueItem,
  hasForegroundDelivery: (id: string) => boolean,
): Promise<"unchanged" | "staged" | "stale"> {
  const owner = chatOutboxOwner(host);
  const sender = head.sender?.identity;
  const client = readCollectClient(host, outbox);
  if (
    !client ||
    head.collectClient !== client ||
    !head.sessionId ||
    !head.collectTabId ||
    !head.storageScope ||
    sender?.type !== "profile" ||
    outbox.queue[0]?.id !== head.id ||
    !visibleSessionMatches(host, outbox.sessionKey, outbox.agentId)
  ) {
    return "unchanged";
  }
  const eligible = (item: ChatQueueItem, current: StoredChatOutbox) =>
    item.collectClient === client &&
    item.collectTabId === head.collectTabId &&
    item.storageScope === head.storageScope &&
    item.sender?.identity?.type === sender.type &&
    item.sender.identity.id === sender.id &&
    item.sessionKey === head.sessionKey &&
    item.agentId === head.agentId &&
    (item.sessionId === undefined || item.sessionId === head.sessionId) &&
    item.sendRunId &&
    !item.collectedBatch &&
    !item.pendingRunId &&
    !item.queueMode &&
    !item.sendAttempts &&
    !item.sendError &&
    item.sendRequestStartedAtMs === undefined &&
    (item.sendState === "waiting-idle" || item.sendState === "waiting-reconnect") &&
    !item.text.trimStart().startsWith("/") &&
    !item.localCommandName &&
    !item.refreshSessions &&
    !item.intent &&
    item.expectedLeafEntryId === undefined &&
    !item.asyncQuestionItemId &&
    !item.replyToId &&
    !item.attachmentStorageError &&
    (!item.attachments?.length || Boolean(item.attachmentPayload)) &&
    !item.attachments?.some(
      (part) => !part.mimeType.startsWith("image/") || part.selectionAnnotation,
    ) &&
    !item.mentions?.length &&
    !item.workContext &&
    !item.workContextUnavailable &&
    !owner.hasVolatile(host, item.id) &&
    !owner.hasPendingSubmission(current, item) &&
    !hasForegroundDelivery(item.id) &&
    !isQueuedMessageBeingEdited(host, item.id);

  const snapshot: ChatQueueItem[] = [];
  const members: CollectMember[] = [];
  const metadata: ChatAttachment[] = [];
  for (const item of outbox.queue.slice(0, MAX_MEMBERS)) {
    if (!eligible(item, outbox)) {
      break;
    }
    const parts = item.attachments ?? [];
    const member: CollectMember = {
      id: item.sendRunId!,
      text: item.text,
      images: parts.map((part, index) => ({
        position: metadata.length + index + 1,
        ...(part.fileName ? { name: part.fileName } : {}),
      })),
    };
    if (
      new TextEncoder().encode(serializeMembers([...members, member])).length > MAX_TEXT_BYTES ||
      attachmentBatchRejection([...metadata, ...parts], host.hello?.policy)
    ) {
      break;
    }
    snapshot.push(item);
    members.push(member);
    metadata.push(...parts);
  }
  if (snapshot.length < 2) {
    return "unchanged";
  }

  if ((await outboxPayloadTab().catch(() => undefined)) !== head.collectTabId) {
    return "unchanged";
  }

  let batch: ChatQueueItem = {
    ...head,
    collectedBatch: true,
    text: serializeMembers(members),
    attachments: undefined,
    attachmentPayload: undefined,
  };
  if (metadata.length) {
    const images: ChatAttachment[] = [];
    for (const item of snapshot) {
      if (!item.attachmentPayload) {
        continue;
      }
      const hydrated = await prepareOutboxPayload(host, item, "handoff");
      if (hydrated.status !== "ready" || !hydrated.update.attachments) {
        return "unchanged";
      }
      images.push(...hydrated.update.attachments);
    }
    const staged = await prepareOutboxPayload(host, { ...batch, attachments: images });
    if (staged.status !== "ready" || !staged.update.attachmentPayload) {
      return "unchanged";
    }
    batch = { ...batch, ...staged.update, attachments: images };
  }

  const current = readChatOutboxLane(host, outbox);
  if (
    !current ||
    readCollectClient(host, outbox) !== client ||
    !visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) ||
    chatSendHoldReason(host, outbox.sessionKey, false, outbox.agentId) ||
    !snapshot.every((expected, index) => {
      const actual = current.queue[index];
      return actual && sameQueuedDeliveryVersion(expected, actual) && eligible(actual, current);
    })
  ) {
    retireOutboxPayload(batch);
    return "stale";
  }

  // A single verified storage write transfers custody, never separate per-row writes.
  // The normal payload garbage collector retires superseded copies after this commit.
  if (
    !updateStoredChatComposerQueueItems(
      host,
      outbox.sessionKey,
      snapshot.map((expected, index) => ({ expected, next: index === 0 ? batch : null })),
      outbox.agentId,
    )
  ) {
    // A read-back failure does not prove that the write failed: leave the staged
    // Blob available for normal recovery rather than deleting possibly owned data.
    return "stale";
  }
  return "staged";
}
