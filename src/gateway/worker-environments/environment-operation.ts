import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { measureGatewayRestartTrace } from "../restart-trace.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentStore } from "./store.js";

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
