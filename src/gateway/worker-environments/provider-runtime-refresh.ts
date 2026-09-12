import type { WorkerProvider } from "../../plugins/types.js";
import { verifyWorkerAdmissionHandshake } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentRecord } from "./store.js";

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
  | "serviceError"
  | "isStopping"
  | "placementStore"
  | "ensureNodeWorkerBundle"
  | "bootstrapWorker"
  | "credentialBroker"
> & {
  requireCurrentOwner: (record: WorkerEnvironmentRecord) => WorkerEnvironmentRecord;
  stopOwner: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord>;
  identityResolverFor: (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    leaseId: string,
  ) => Parameters<WorkerProviderLifecycleOptions["bootstrapWorker"]>[0]["resolveIdentity"];
};

export function createWorkerRuntimeRefresher(options: WorkerRuntimeRefreshOptions) {
  const {
    store,
    callBootstrap,
    serviceError,
    requireCurrentOwner,
    stopOwner,
    identityResolverFor,
  } = options;
  const { ensurePendingCredential } = options.credentialBroker;
  const refreshRuntime = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact | undefined,
    signal?: AbortSignal,
  ) => {
    if (
      !installation ||
      (record.bootstrapReceipt &&
        verifyWorkerAdmissionHandshake(record.bootstrapReceipt, installation))
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
    const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : undefined;
    const assertOwnerCurrent = () => {
      signal?.throwIfAborted();
      const current = requireCurrentOwner(record);
      if (options.isStopping() || current.destroyRequestedAtMs !== null) {
        throw serviceError("invalid_state", "Worker runtime refresh owner is stopping");
      }
      if (record.state === "attached") {
        if (!sessionId || !options.placementStore) {
          throw serviceError("invalid_state", "Worker runtime refresh requires its placement");
        }
        return options.placementStore.assertWorkerRuntimeRefresh({
          sessionId,
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
        });
      }
      return undefined;
    };
    const expectedPlacementGeneration = assertOwnerCurrent();
    const assertCurrent = () => {
      if (assertOwnerCurrent() !== expectedPlacementGeneration) {
        throw serviceError("invalid_state", "Worker runtime refresh placement changed");
      }
    };
    // Stop the old process and revoke its credential, but retain the epoch: it also owns
    // the node workspace directory. A new turn gets a new claim and credential below.
    await stopOwner(record);
    assertCurrent();
    const receipt = await callBootstrap(installation, async (timeoutSignal) => {
      const refreshSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      assertCurrent();
      if (record.nodeDeviceId) {
        if (installation.install !== "bundle" || !options.ensureNodeWorkerBundle) {
          throw new Error("Worker node bundle installer is unavailable");
        }
        return options.ensureNodeWorkerBundle({
          deviceId: record.nodeDeviceId,
          artifact: installation,
          prewarm: record.profileSnapshot.executionMode !== "remote-exec",
          signal: refreshSignal,
          assertCurrent,
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
    assertCurrent();
    if (!verifyWorkerAdmissionHandshake(receipt, installation)) {
      throw new Error("Worker runtime refresh returned a mismatched build receipt");
    }
    const refreshed = store.refreshBootstrapReceipt({
      environmentId: record.environmentId,
      ...(record.state === "attached"
        ? { expectedState: record.state, expectedPlacementGeneration: expectedPlacementGeneration! }
        : { expectedState: record.state }),
      expectedOwnerEpoch: record.ownerEpoch,
      expectedNodeDeviceId: record.nodeDeviceId,
      expectedBootstrapReceipt: record.bootstrapReceipt,
      bootstrapReceipt: { ...receipt, installKind: "bundle" },
      assertCurrent,
    });
    ensurePendingCredential(refreshed, sessionId ?? null);
  };

  return refreshRuntime;
}
