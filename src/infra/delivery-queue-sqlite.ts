// Stores durable delivery queue entries through their connection-bound owner.
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  loadDeliveryQueueEntryInDatabase,
  type DeliveryQueueReadMode,
} from "./delivery-queue-sqlite-bound.js";
import {
  countPendingDeliveryQueueEntriesInDatabase,
  deleteDeliveryQueueEntryInDatabase,
  getDeliveryQueueEntryOwnersInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  pruneExpiredDeliveryQueueTombstonesInDatabase,
  reserveDeliveryQueueEntryAttemptInDatabase,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
  type DeliveryQueueStoredStatus,
  type ReserveDeliveryQueueAttemptResult,
  type TerminalizePendingDeliveryQueueEntryParams,
  type TerminalizePendingDeliveryQueueEntryResult,
} from "./delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import {
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

/** Load a single pending delivery queue entry. */
export function loadDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
  context?: DeliveryQueueStateContext,
): DeliveryQueueEntryState | null {
  return loadDeliveryQueueEntryInDatabase(
    openStateDatabase(stateDir, context),
    queueName,
    id,
    mode,
  );
}

/** Read row status without hiding dead-lettered entries. */
export function getDeliveryQueueEntryStatus(
  queueName: string,
  id: string,
  stateDir?: string,
): DeliveryQueueStoredStatus | undefined {
  return getDeliveryQueueEntryOwners([queueName], id, stateDir).get(queueName)?.status;
}

/** Read one exact ID across physical namespaces from a single ownership snapshot. */
export function getDeliveryQueueEntryOwners(
  queueNames: readonly string[],
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Map<string, { status: DeliveryQueueStoredStatus; settlementPending?: true }> {
  if (queueNames.length === 0) {
    return new Map();
  }
  return getDeliveryQueueEntryOwnersInDatabase(
    openStateDatabase(stateDir, context),
    queueNames,
    id,
  );
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

/** Delete a pending delivery queue entry after successful delivery. */
export function deleteDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): void {
  deleteDeliveryQueueEntryInDatabase(openStateDatabase(stateDir, context), queueName, id);
}

/** Load, transform, and persist a pending delivery queue entry. */
export function updateDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir: string | undefined,
  update: (entry: DeliveryQueueEntryState) => DeliveryQueueEntryState,
  context?: DeliveryQueueStateContext,
): void {
  updateDeliveryQueueEntryInDatabase(openStateDatabase(stateDir, context), queueName, id, update);
}

/** Atomically reserve one provider-delivery call before executing it. */
export function reserveDeliveryQueueEntryAttempt(
  params: {
    queueName: string;
    id: string;
    maxAttempts: number;
    stateDir?: string;
    expectedPlatformSendAttemptId?: string;
  },
  context?: DeliveryQueueStateContext,
): ReserveDeliveryQueueAttemptResult {
  if (!Number.isInteger(params.maxAttempts) || params.maxAttempts <= 0) {
    throw new Error(`Invalid delivery attempt budget: ${params.maxAttempts}`);
  }
  return runOpenClawStateWriteTransaction(
    (database) => reserveDeliveryQueueEntryAttemptInDatabase(database, params),
    {
      env: resolveDeliveryQueueStateEnv(params.stateDir, context),
    },
    {
      operationLabel: `reserve ${params.queueName} delivery attempt`,
    },
  );
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
export function countPendingDeliveryQueueEntries(
  queueNames: readonly string[],
  stateDir?: string,
): number {
  if (queueNames.length === 0) {
    return 0;
  }
  return countPendingDeliveryQueueEntriesInDatabase(openStateDatabase(stateDir), queueNames);
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
export function pruneExpiredDeliveryQueueTombstones(stateDir?: string): void {
  pruneExpiredDeliveryQueueTombstonesInDatabase(openStateDatabase(stateDir));
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
