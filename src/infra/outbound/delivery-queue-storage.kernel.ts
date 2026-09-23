import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { transitionOwnedDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-claim.kernel.js";
import { upsertDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

/** Restore the exact pre-attempt row while its original owner still holds custody. */
export function restoreDeliveryAttemptBeforeDispatchInDatabase(
  database: OpenClawStateDatabase,
  entry: QueuedDelivery,
  reservedAttemptCount: number,
  claimedAttemptId?: string,
): void {
  const restored = transitionOwnedDeliveryQueueEntryInDatabase(
    database,
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id: entry.id,
      platformSendAttemptId: claimedAttemptId ?? null,
    },
    (currentRow) => {
      // SAFETY: The claimed pending row belongs to the prepared outbound namespace.
      const current = currentRow as QueuedDelivery;
      if (current.attemptCount !== reservedAttemptCount) {
        throw new Error(`Delivery attempt reservation changed before rollback: ${entry.id}`);
      }
      const restoredEntry: QueuedDelivery = {
        ...current,
        attemptCount: entry.attemptCount,
        availableAt: entry.availableAt,
        producerClaimId: entry.producerClaimId,
        platformSendAttemptId: entry.platformSendAttemptId,
        platformSendStartedAt: entry.platformSendStartedAt,
        effectiveReplyToId: entry.effectiveReplyToId,
        recoveryState: entry.recoveryState,
      };
      upsertDeliveryQueueEntryInDatabase(
        {
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          entry: restoredEntry,
        },
        database,
      );
    },
  );
  if (!restored) {
    throw new Error(`Delivery platform claim was lost: ${entry.id}`);
  }
}
