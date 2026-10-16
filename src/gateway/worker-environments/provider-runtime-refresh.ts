import type { WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export type WorkerRuntimeRefreshInFlight = {
  /** Settles after the refresh finishes or fails; never rejects. */
  readonly settled: Promise<void>;
  /** Observe real install progress until the returned function unsubscribes. */
  onProgress(listener: () => void): () => void;
};

export class WorkerRuntimeRefreshPendingError extends Error {
  readonly code = "invalid_state";

  constructor(detail: string) {
    super(
      `Cloud worker runtime update is pending; recovery will retry when the worker is available: ${detail}`,
    );
  }
}

type WorkerRuntimeRefreshOptions = Pick<
  WorkerProviderLifecycleOptions,
  | "store"
  | "callBootstrap"
  | "isStopping"
  | "placementStore"
  | "ensureNodeWorkerBundle"
  | "bootstrapWorker"
  | "credentialBroker"
> &
  Pick<
    ReturnType<typeof createWorkerProviderOwnerLifecycle>,
    "requireCurrentOwner" | "stopOwner" | "identityResolverFor"
  >;

export function createWorkerRuntimeRefresher(options: WorkerRuntimeRefreshOptions) {
  const { store, callBootstrap, requireCurrentOwner, stopOwner, identityResolverFor } = options;
  const { ensurePendingCredential } = options.credentialBroker;
  const inFlight = new Map<string, WorkerRuntimeRefreshInFlight>();
  const refresh = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact | undefined,
    signal?: AbortSignal,
  ) => {
    if (
      !installation ||
      (record.bootstrapReceipt && sameWorkerBuild(record.bootstrapReceipt, installation))
    ) {
      return;
    }
    if (
      (record.state !== "attached" && record.state !== "ready" && record.state !== "idle") ||
      !record.bootstrapReceipt ||
      !record.leaseId
    ) {
      throw serviceError("invalid_state", "Worker runtime refresh requires an admitted lease");
    }
    const settled = createDeferredCore();
    const listeners = new Set<() => void>();
    const fact: WorkerRuntimeRefreshInFlight = {
      settled: settled.promise,
      onProgress: (listener) => registerListener(listeners, listener),
    };
    const reportProgress = () => notifyListeners(listeners, undefined);
    inFlight.set(record.environmentId, fact);
    try {
      const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : undefined;
      let placementAuthority:
        | Awaited<ReturnType<WorkerSessionPlacementGate["prepareWorkerRuntimeRefresh"]>>
        | undefined;
      if (record.state === "attached") {
        if (!sessionId || !options.placementStore) {
          throw serviceError("invalid_state", "Worker runtime refresh requires its placement");
        }
        placementAuthority = await options.placementStore.prepareWorkerRuntimeRefresh({
          sessionId,
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
        });
      }
      const assertCurrent = () => {
        signal?.throwIfAborted();
        const current = requireCurrentOwner(record);
        if (options.isStopping() || current.destroyRequestedAtMs !== null) {
          throw serviceError("invalid_state", "Worker runtime refresh owner is stopping");
        }
        placementAuthority?.assertCurrent();
      };
      try {
        // Stop the old process and revoke its credential, but retain the epoch: it also owns
        // the node workspace directory. A new turn gets a new claim and credential below.
        await stopOwner(record, undefined, { assertCurrent });
        const receipt = await callBootstrap(installation, async (timeoutSignal) => {
          const refreshSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
          assertCurrent();
          if (record.nodeDeviceId) {
            if (installation.install !== "bundle" || !options.ensureNodeWorkerBundle) {
              throw new Error("Worker node bundle installer is unavailable");
            }
            return options.ensureNodeWorkerBundle({
              reason: "refresh",
              environmentId: record.environmentId,
              deviceId: record.nodeDeviceId,
              artifact: installation,
              prewarm: record.profileSnapshot.executionMode !== "remote-exec",
              signal: refreshSignal,
              assertCurrent,
              onProgress: reportProgress,
            });
          }
          if (!record.sshEndpoint) {
            throw new Error("Worker runtime refresh has no transport");
          }
          return options.bootstrapWorker({
            operationId: record.provisionOperationId,
            sshEndpoint: record.sshEndpoint,
            installation,
            resolveIdentity: identityResolverFor(record, provider, record.leaseId!),
            signal: refreshSignal,
            assertCurrent,
          });
        });
        if (!sameWorkerBuild(receipt, installation)) {
          throw new Error("Worker runtime refresh returned a mismatched build receipt");
        }
        const refreshed = await store.refreshBootstrapReceipt({
          environmentId: record.environmentId,
          ...(record.state === "attached"
            ? {
                expectedState: record.state,
                expectedPlacementGeneration: placementAuthority!.generation,
                expectedReclaimResult: placementAuthority!.reclaimResult,
              }
            : { expectedState: record.state }),
          expectedOwnerEpoch: record.ownerEpoch,
          expectedNodeDeviceId: record.nodeDeviceId,
          expectedBootstrapReceipt: record.bootstrapReceipt,
          bootstrapReceipt: { ...receipt, installKind: "bundle" },
          assertCurrent,
        });
        await ensurePendingCredential(refreshed, sessionId ?? null);
      } finally {
        placementAuthority?.release();
      }
    } finally {
      inFlight.delete(record.environmentId);
      settled.resolve();
    }
  };
  return { refresh, read: (environmentId: string) => inFlight.get(environmentId) };
}
