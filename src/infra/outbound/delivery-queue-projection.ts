import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DeliveryQueueEntryState } from "../delivery-queue-sqlite.types.js";
import {
  COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_EXECUTABLE_QUEUE_NAMES,
  outboundDeliveryQueueName,
} from "./delivery-queue-namespaces.js";
import type { OutboundDeliverySnapshot } from "./delivery-queue-storage.types.js";
import type { QueuedDelivery, QueuedDeliveryPayload } from "./delivery-queue-types.js";

/** Copies shared send options without transferring queue custody or process-local callbacks. */
export function projectQueuedDeliveryOptions(params: QueuedDeliveryPayload) {
  return {
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    formatting: params.formatting,
    identity: params.identity,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mirror: params.mirror,
    session: params.session,
    gatewayClientScopes: params.gatewayClientScopes,
    preparedMessageId: params.preparedMessageId,
  };
}

export function projectOutboundDelivery(
  queueName: string,
  entry: DeliveryQueueEntryState,
): QueuedDelivery {
  if (!OUTBOUND_EXECUTABLE_QUEUE_NAMES.some((name) => name === queueName)) {
    throw new Error(`Unsupported outbound delivery format: ${queueName}`);
  }
  // SAFETY: Only executable outbound namespaces store prepared delivery payloads.
  const delivery = entry as QueuedDelivery;
  if (queueName === COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME) {
    if (delivery.deliveryCompletion?.kind !== "pending-final") {
      throw new Error(`Missing command-owner delivery completion: ${entry.id}`);
    }
    delivery.deliveryCompletion.commandOwnerReference ??= null;
  }
  if (queueName !== outboundDeliveryQueueName(delivery)) {
    throw new Error(`Outbound delivery authority does not match its format: ${entry.id}`);
  }
  return delivery;
}

export function encodeOutboundDeliverySnapshot(entry: QueuedDelivery): OutboundDeliverySnapshot {
  return { queueName: outboundDeliveryQueueName(entry), entryJson: JSON.stringify(entry) };
}

export function decodeOutboundDeliverySnapshot(snapshot: OutboundDeliverySnapshot): QueuedDelivery {
  const entry: unknown = JSON.parse(snapshot.entryJson);
  if (
    !isRecord(entry) ||
    typeof entry.id !== "string" ||
    typeof entry.enqueuedAt !== "number" ||
    typeof entry.retryCount !== "number"
  ) {
    throw new Error("Invalid outbound delivery storage snapshot");
  }
  return projectOutboundDelivery(snapshot.queueName, {
    ...entry,
    id: entry.id,
    enqueuedAt: entry.enqueuedAt,
    retryCount: entry.retryCount,
  });
}
