import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentRecord } from "./store.js";

/** Prepared recovery retains provider settlement inside the existing environment queue. */
export function createPreparedWorkerRecovery(
  options: Pick<WorkerProviderLifecycleOptions, "store" | "withLock"> & {
    expirePrepared: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord>;
    finishDestroy: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord>;
    reconcileRecord: (
      record: WorkerEnvironmentRecord,
      signal?: AbortSignal,
      retainProviderSettlement?: (settled: Promise<void>) => void,
      beforeProvision?: () => void,
    ) => Promise<void>;
  },
) {
  return (record: WorkerEnvironmentRecord, signal?: AbortSignal, beforeReconcile?: () => void) =>
    options.withLock(record.environmentId, async () => {
      signal?.throwIfAborted();
      beforeReconcile?.();
      let current = options.store.get(record.environmentId);
      if (!current || !current.preparation || current.preparation.consumedAtMs !== null) {
        return current;
      }
      current = await options.expirePrepared(current);
      if (current.destroyRequestedAtMs !== null) {
        return options.finishDestroy(current);
      }
      // Keep the reserve slot and lock until any timed-out allocation actually settles.
      const providerSettlements: Promise<void>[] = [];
      try {
        await options.reconcileRecord(
          current,
          signal ?? new AbortController().signal,
          (settled) => providerSettlements.push(settled),
          beforeReconcile,
        );
      } finally {
        await Promise.all(providerSettlements);
      }
      return options.store.get(record.environmentId);
    });
}
