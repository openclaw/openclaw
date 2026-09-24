import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import {
  deliveryQueueEntriesQuery,
  inflateDeliveryQueueRow,
  loadDeliveryQueueEntryInDatabase,
  type DeliveryQueueReadMode,
} from "../delivery-queue-sqlite-bound.js";
import { transitionOwnedDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-claim.kernel.js";
import { upsertDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { executeSqliteQuerySync } from "../kysely-sync.js";
import {
  OUTBOUND_EXECUTABLE_QUEUE_NAMES,
  outboundDeliveryQueueName,
} from "./delivery-queue-namespaces.js";
import { resolveOutboundDeliveryQueueNameInDatabase } from "./delivery-queue-ownership.kernel.js";
import { projectOutboundDelivery } from "./delivery-queue-projection.js";
import type { OutboundDeliveryStorageEntry } from "./delivery-queue-storage.types.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

/** Restore the exact pre-attempt row while its original owner still holds custody. */
export function restoreDeliveryAttemptBeforeDispatchInDatabase(
  database: OpenClawStateDatabase,
  entry: QueuedDelivery,
  reservedAttemptCount: number,
  claimedAttemptId?: string,
): void {
  const queueName = outboundDeliveryQueueName(entry);
  const restored = transitionOwnedDeliveryQueueEntryInDatabase(
    database,
    {
      queueName,
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
          queueName,
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

export function loadOutboundDeliveryInDatabase(
  database: OpenClawStateDatabase,
  id: string,
  mode: DeliveryQueueReadMode,
): QueuedDelivery | null {
  const queueName = resolveOutboundDeliveryQueueNameInDatabase(database, id);
  const entry = loadDeliveryQueueEntryInDatabase(database, queueName, id, mode);
  if (!entry) {
    return null;
  }
  return projectOutboundDelivery(queueName, entry);
}

/** One read snapshot orders all executable formats without pruning or mutating custody. */
export function readOutboundDeliveriesInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  input: { id?: string; mode: "pending" | "unfinished" },
): OutboundDeliveryStorageEntry[] {
  let query = deliveryQueueEntriesQuery(database, OUTBOUND_EXECUTABLE_QUEUE_NAMES, input.mode)
    .select("queue_name")
    .orderBy("enqueued_at", "asc")
    .orderBy("id", "asc");
  if (input.id !== undefined) {
    query = query.where("id", "=", input.id);
  }
  const seen = new Set<string>();
  return executeSqliteQuerySync(database.db, query).rows.flatMap((row) => {
    const entry = inflateDeliveryQueueRow(row);
    if (!entry) {
      return [];
    }
    if (seen.has(entry.id)) {
      throw new Error(`Ambiguous outbound delivery custody: ${entry.id}`);
    }
    seen.add(entry.id);
    return [{ queueName: row.queue_name, entry: projectOutboundDelivery(row.queue_name, entry) }];
  });
}
