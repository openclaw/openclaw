import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { computeBackoff } from "../../infra/backoff.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { measureGatewayRestartTrace } from "../restart-trace.js";
import type {
  WorkerEnvironmentReconcileCore,
  WorkerEnvironmentReconcileGuard,
} from "./environment-reconcile.types.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { createWorkerReconcileCancellation } from "./provider-provisioning-cancellation.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

export function createWorkerReconcileTrace(record: { environmentId: string; providerId?: string }) {
  return <T>(name: string, run: () => Promise<T>) =>
    measureGatewayRestartTrace(
      `worker-environments.reconcile.${name}`,
      run,
      () => ({ environment: record.environmentId, provider: record.providerId }),
      true,
    );
}

export function createWorkerProviderCaller(options: {
  store: Pick<WorkerEnvironmentStore, "get">;
  trackOperation: <T>(operation: Promise<T>) => Promise<T>;
  providerCallTimeoutMs?: number;
}): WorkerProviderLifecycleOptions["callProvider"] {
  const providerOperations = new KeyedAsyncQueue();
  return async <T>(
    environmentId: string,
    operationName: string,
    run: () => Promise<T>,
    timeoutMs?: number,
    observationSignal?: AbortSignal,
  ): Promise<T> => {
    // Shutdown diagnostics must survive retirement of the inventory reader.
    const providerId = options.store.get(environmentId)?.providerId;
    const { promise: started, resolve: signalStarted } = createDeferredCore();
    const operation = options.trackOperation(
      measureGatewayRestartTrace(
        "worker-environments.provider",
        () =>
          providerOperations.enqueue(environmentId, async () => {
            signalStarted();
            observationSignal?.throwIfAborted();
            // Read-only observations may release their queue slot before a late reply.
            return await racePromiseWithAbortSignal(run(), observationSignal);
          }),
        () => ({
          environment: environmentId,
          provider: providerId,
          step: operationName,
        }),
        true,
      ),
    );
    await racePromiseWithAbortSignal(started, observationSignal);
    // A timeout cannot release mutation ownership or permit replay/destroy overlap.
    return await withTimeout(
      operation,
      options.providerCallTimeoutMs ?? timeoutMs ?? 300_000,
      "Worker provider operation",
    );
  };
}

export function createWorkerEnvironmentReconciler(options: {
  store: Pick<WorkerEnvironmentStore, "get">;
  ownerSignal: AbortSignal;
  isPaused: () => boolean;
  now: () => number;
  warn: (message: string) => void;
  reconcileCore: (
    environmentId: string,
    ...args: Parameters<WorkerEnvironmentReconcileCore>
  ) => Promise<void>;
}) {
  const {
    store,
    now,
    warn,
    isPaused: isReconciliationPaused,
    reconcileCore: reconcileEnvironmentCore,
  } = options;
  let reconcileEnvironmentGuard: WorkerEnvironmentReconcileGuard | undefined;
  let reconcileEnvironmentGuardClosing = false;
  // Coalesce the whole guarded closure. Serializing only provider work would still let a
  // losing recovery pass attach or sync after the winner advances the placement.
  const guardedReconcileInFlight = new Map<string, Promise<void>>();
  const reconcileFailures = new Map<
    string,
    { record: WorkerEnvironmentRecord; attempts: number; retryAtMs: number }
  >();
  const readReconcileFailure = (environmentId: string) => {
    const failure = reconcileFailures.get(environmentId);
    if (!failure) {
      return undefined;
    }
    const current = store.get(environmentId);
    const previous = failure.record;
    if (
      !current ||
      ["destroyed", "failed", "orphaned"].includes(current.state) ||
      current.ownerEpoch !== previous.ownerEpoch ||
      current.state !== previous.state ||
      current.leaseId !== previous.leaseId ||
      current.destroyRequestedAtMs !== previous.destroyRequestedAtMs
    ) {
      reconcileFailures.delete(environmentId);
      return undefined;
    }
    return failure;
  };
  const reconcileEnvironment = async (environmentId: string) => {
    if (isReconciliationPaused() || reconcileEnvironmentGuardClosing) {
      return;
    }
    const guard = reconcileEnvironmentGuard;
    const active = guardedReconcileInFlight.get(environmentId);
    if (active) {
      return await active;
    }
    using cancellation = createWorkerReconcileCancellation(options.ownerSignal);
    const reconcile = (signal = cancellation.signal, retain?: (settled: Promise<void>) => void) =>
      reconcileEnvironmentCore(
        environmentId,
        AbortSignal.any([cancellation.signal, signal]),
        retain,
      );
    const operation = guard ? guard(environmentId, reconcile, cancellation.signal) : reconcile();
    guardedReconcileInFlight.set(environmentId, operation);
    try {
      await operation;
      reconcileFailures.delete(environmentId);
    } catch (error) {
      const record = store.get(environmentId);
      if (record && !cancellation.signal.aborted) {
        const attempts = (readReconcileFailure(environmentId)?.attempts ?? 0) + 1;
        const delay = computeBackoff(
          { initialMs: 60_000, maxMs: 900_000, factor: 2, jitter: 0 },
          attempts,
        );
        reconcileFailures.set(environmentId, { record, attempts, retryAtMs: now() + delay });
      }
      throw error;
    } finally {
      guardedReconcileInFlight.delete(environmentId);
    }
  };

  const closeReconcileEnvironmentGuard = async () => {
    reconcileEnvironmentGuardClosing = true;
    await Promise.allSettled(guardedReconcileInFlight.values());
    reconcileEnvironmentGuard = undefined;
    reconcileEnvironmentGuardClosing = false;
  };

  const installReconcileEnvironmentGuard = (guard: WorkerEnvironmentReconcileGuard) => {
    if (reconcileEnvironmentGuard) {
      throw new Error("Worker environment reconciliation guard is already installed");
    }
    reconcileEnvironmentGuard = guard;
    return closeReconcileEnvironmentGuard;
  };

  return {
    reconcileEnvironment,
    installReconcileEnvironmentGuard,
    closeReconcileEnvironmentGuard,
    backgroundCandidates: (records: WorkerEnvironmentRecord[]) => {
      // Retire failures with their inventory owner; restart retries immediately.
      for (const id of reconcileFailures.keys()) {
        readReconcileFailure(id);
      }
      // Decide before the guard can repeat expensive workspace recovery.
      return records.filter(
        (record) => (readReconcileFailure(record.environmentId)?.retryAtMs ?? 0) <= now(),
      );
    },
    reconcileCandidate: (record: WorkerEnvironmentRecord) =>
      measureGatewayRestartTrace(
        "worker-environments.reconcile.environment",
        () => reconcileEnvironment(record.environmentId),
        () => ({ environment: record.environmentId, provider: record.providerId }),
        true,
      ).catch(() => {
        const failure = readReconcileFailure(record.environmentId);
        warn(
          `Worker environment reconcile failed (${record.environmentId}, ${record.providerId})` +
            (failure ? `; attempt=${failure.attempts} retryAtMs=${failure.retryAtMs}` : ""),
        );
      }),
    clearFailures: () => reconcileFailures.clear(),
  };
}
