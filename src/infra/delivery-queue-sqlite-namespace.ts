import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  assertDeliveryQueueReplacement,
  replacePendingDeliveryQueueEntryInDatabase,
  movePendingDeliveryQueueEntryNamespaceInDatabase,
} from "./delivery-queue-sqlite-namespace.kernel.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "./delivery-queue-sqlite.js";

type MovePendingDeliveryQueueEntryNamespaceParams = Parameters<
  typeof movePendingDeliveryQueueEntryNamespaceInDatabase
>[1] & {
  stateDir?: string;
};

/** Replaces a pending entry only while its authoritative serialized value is unchanged. */
export function replacePendingDeliveryQueueEntry(
  params: Parameters<typeof replacePendingDeliveryQueueEntryInDatabase>[1] & {
    stateDir?: string;
  },
  context?: DeliveryQueueStateContext,
): boolean {
  assertDeliveryQueueReplacement(params);
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
