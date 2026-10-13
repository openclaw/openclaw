// Stores durable delivery queue entries through their connection-bound owner.
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { DeliveryQueueReadMode } from "./delivery-queue-sqlite-bound.js";
import {
  countPendingDeliveryQueueEntriesInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  type TerminalizePendingDeliveryQueueEntryParams,
  type TerminalizePendingDeliveryQueueEntryResult,
} from "./delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import {
  captureDeliveryQueueStateContext,
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "./delivery-queue-state-context.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";

export type {
  DeliveryQueueCompletionRetention,
  DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.types.js";

export {
  captureDeliveryQueueStateContext,
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "./delivery-queue-state-context.js";

function openStateDatabase(stateDir?: string, context?: DeliveryQueueStateContext) {
  return openOpenClawStateDatabase({
    env: resolveDeliveryQueueStateEnv(stateDir, context),
  });
}

/** Select receipt and pending custody together, preserving bounded receipt expiry. */
export async function inspectDeliveryQueueReceipt(
  queueName: string,
  id: string,
  includePending: boolean,
  context: DeliveryQueueStateContext,
) {
  const result = await executeDeliveryQueueOperation(context, undefined, {
    type: "deliveryQueue.inspectReceipt",
    input: { queueName, id, includePending },
  });
  context.workerContext.admission.assertCurrent();
  return result;
}

/** Load all pending entries for a queue namespace in database order. */
export function loadDeliveryQueueEntries(
  queueName: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
  context?: DeliveryQueueStateContext,
): DeliveryQueueEntryState[] {
  return loadDeliveryQueueEntriesInDatabase(openStateDatabase(stateDir, context), queueName, mode);
}

/** Count dead-lettered entries per queue namespace for coarse health reporting. */
export async function countFailedDeliveryQueueEntries(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<Array<{ queueName: string; count: number; oldestFailedAt?: number }>> {
  return executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.countFailed",
    input: undefined,
  });
}

/** Count pending entries across an exact set of queue namespaces. */
export async function countPendingDeliveryQueueEntries(
  queueNames: readonly string[],
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<number> {
  if (queueNames.length === 0) {
    return 0;
  }
  const captured = context ?? captureDeliveryQueueStateContext(stateDir);
  const count = await executeDeliveryQueueOperation(captured, undefined, {
    type: "deliveryQueue.countPending",
    input: { queueNames: [...queueNames] },
  });
  captured.workerContext.admission.assertCurrent();
  return count;
}

/** Doctor's offline migration retains its admitted native database owner. */
export function countPendingDeliveryQueueEntriesForMaintenance(
  queueNames: readonly string[],
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): number {
  if (queueNames.length === 0) {
    return 0;
  }
  return countPendingDeliveryQueueEntriesInDatabase(
    openStateDatabase(stateDir, context),
    queueNames,
  );
}

/** Inventory retired custody without opening a writer or creating state. */
export async function countPendingDeliveryQueueEntriesReadOnly(
  queueNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return (
    (await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
      (database) => countPendingDeliveryQueueEntriesInDatabase(database, queueNames),
      { env },
    )) ?? 0
  );
}

/** Physically expire age-bounded delivery queue tombstones. */
export async function pruneExpiredDeliveryQueueTombstones(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.pruneTombstones",
    input: undefined,
  });
}

/** Atomically delete or tombstone a pending row only while its value is unchanged. */
export function terminalizePendingDeliveryQueueEntry(
  params: TerminalizePendingDeliveryQueueEntryParams & { stateDir?: string },
  context?: DeliveryQueueStateContext,
): TerminalizePendingDeliveryQueueEntryResult {
  const prepared = prepareDeliveryQueueTerminalEntry(params);
  return terminalizePendingDeliveryQueueEntryInDatabase(
    openStateDatabase(params.stateDir, context),
    prepared,
  );
}
