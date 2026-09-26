import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  replacePendingDeliveryQueueEntryInDatabase,
  movePendingDeliveryQueueEntryNamespaceInDatabase,
} from "./delivery-queue-sqlite-namespace.kernel.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";

type MovePendingDeliveryQueueEntryNamespaceParams = Parameters<
  typeof movePendingDeliveryQueueEntryNamespaceInDatabase
>[1] & {
  stateDir?: string;
};

/** Replaces a pending entry only while its authoritative serialized value is unchanged. */
export function replacePendingDeliveryQueueEntry(
  params: {
    queueName: string;
    expectedEntry: DeliveryQueueEntryState;
    replacementEntry: DeliveryQueueEntryState;
    stateDir?: string;
  },
  context?: DeliveryQueueStateContext,
): boolean {
  if (params.expectedEntry.id !== params.replacementEntry.id) {
    throw new Error(
      `Delivery queue replacement id mismatch: ${params.expectedEntry.id} != ${params.replacementEntry.id}`,
    );
  }
  return runOpenClawStateWriteTransaction(
    (database) => replacePendingDeliveryQueueEntryInDatabase(database, params),
    { env: resolveDeliveryQueueStateEnv(params.stateDir, context) },
    { operationLabel: "replace pending delivery queue entry" },
  );
}

/**
 * Commits an asynchronously prepared replacement only if the authoritative
 * source row is unchanged, then removes or terminally fences the old owner.
 */
export function movePendingDeliveryQueueEntryNamespace(
  params: MovePendingDeliveryQueueEntryNamespaceParams,
  context?: DeliveryQueueStateContext,
): "moved" | "source-changed" | "destination-exists" | "staging-missing" {
  return runOpenClawStateWriteTransaction(
    (database) => movePendingDeliveryQueueEntryNamespaceInDatabase(database, params),
    { env: resolveDeliveryQueueStateEnv(params.stateDir, context) },
    { operationLabel: "migrate delivery queue namespace" },
  );
}
