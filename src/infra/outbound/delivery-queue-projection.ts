import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DeliveryQueueEntryState } from "../delivery-queue-sqlite.types.js";
import {
  OUTBOUND_DELIVERY_QUEUE_NAME,
  SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME,
  outboundDeliveryQueueName,
} from "./delivery-queue-namespaces.js";
import type { OutboundDeliverySnapshot } from "./delivery-queue-storage.types.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

export function projectOutboundDelivery(
  queueName: string,
  entry: DeliveryQueueEntryState,
): QueuedDelivery {
  if (
    queueName !== OUTBOUND_DELIVERY_QUEUE_NAME &&
    queueName !== SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME
  ) {
    throw new Error(`Unsupported outbound delivery format: ${queueName}`);
  }
  // SAFETY: Only executable outbound namespaces store prepared delivery payloads.
  const delivery = entry as QueuedDelivery;
  if (
    (queueName === SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME) !==
    (delivery.sessionGeneration !== undefined)
  ) {
    throw new Error(`Outbound delivery generation does not match its format: ${entry.id}`);
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
