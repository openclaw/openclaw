import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import {
  commitStagedDeliveryQueueEntryOnceAcrossNamespacesInDatabase,
  movePendingDeliveryQueueEntryNamespaceInDatabase,
  upsertDeliveryQueueEntryOnceAcrossNamespacesInDatabase,
} from "../delivery-queue-sqlite-namespace.kernel.js";
import { upsertDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueEntryState } from "../delivery-queue-sqlite.types.js";
import type { DeliveryQueueWorkerOperations } from "../delivery-queue.worker-contract.js";
import { stageSqliteTransactionState } from "../sqlite-post-commit.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_EXECUTABLE_QUEUE_NAMES,
  outboundDeliveryQueueName,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-namespaces.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

export function executeDeliveryQueueEnqueue(
  input: DeliveryQueueWorkerOperations["deliveryQueue.enqueue"]["input"],
  writeOptions: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): DeliveryQueueWorkerOperations["deliveryQueue.enqueue"]["output"] {
  // SAFETY: Only the host enqueue owner supplies this canonical, typed queue-entry JSON.
  const entry = JSON.parse(input.entryJson) as QueuedDelivery;
  const queueName = outboundDeliveryQueueName(entry);
  const conflictQueueNames = [
    ...OUTBOUND_EXECUTABLE_QUEUE_NAMES.filter((name) => name !== queueName),
    OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
    OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  ];
  const transaction: { outcome: "unobserved" | "pending" | "committed" | "rolled-back" } = {
    outcome: "unobserved",
  };
  try {
    return runOpenClawStateWriteTransaction(
      (database) => {
        stageSqliteTransactionState(database.db, {
          stage: () => {
            transaction.outcome = "pending";
          },
          commit: () => {
            transaction.outcome = "committed";
          },
          rollback: () => {
            transaction.outcome = "rolled-back";
          },
        });
        // Random inserts need the same rollback evidence as staged enqueues.
        if (input.kind === "random" && !input.mediaStageId) {
          upsertDeliveryQueueEntryInDatabase({ queueName, entry }, database);
          return "created";
        }
        if (input.kind === "prepared") {
          return movePendingDeliveryQueueEntryNamespaceInDatabase(database, {
            sourceQueueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
            destinationQueueName: queueName,
            conflictQueueNames,
            // SAFETY: The host serializes its typed preparation snapshot before yielding.
            expectedSourceEntry: JSON.parse(input.preparationJson) as DeliveryQueueEntryState,
            destinationEntry: entry,
            ...(input.mediaStageId
              ? {
                  stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
                  stagingId: input.mediaStageId,
                }
              : {}),
          });
        }
        const params = {
          queueName,
          conflictQueueNames:
            input.kind === "stable"
              ? [...conflictQueueNames, OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME]
              : [],
          entry,
        };
        if (input.mediaStageId) {
          return commitStagedDeliveryQueueEntryOnceAcrossNamespacesInDatabase(database, {
            ...params,
            stagingId: input.mediaStageId,
            stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
          });
        }
        return upsertDeliveryQueueEntryOnceAcrossNamespacesInDatabase(database, params)
          ? "created"
          : "existing";
      },
      writeOptions,
      { operationLabel: "enqueue outbound delivery" },
    );
  } catch (cause) {
    // Coordinator cleanup happens after commit publication and cannot prove rollback.
    if (transaction.outcome === "rolled-back") {
      const error = encodeOpenClawStateWorkerError(cause, { includeOrdinary: true });
      if (error) {
        return { status: "not-published", error };
      }
    }
    throw cause;
  }
}
