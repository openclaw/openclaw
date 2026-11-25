import type { WorkerNodeRuntimeIdentity, WorkerProvider } from "../../plugins/types.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import type { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import type { WorkerProviderRepositorySource } from "./provider-project-preparation.js";
import { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import {
  restoreWorkerProvisionSource,
  WorkerProvisionSourceRecoveryPendingError,
} from "./provision-source-authority.js";
import * as check from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

type WorkerProvisionResumeOptions = Pick<
  WorkerProviderLifecycleOptions,
  "store" | "move" | "saveError" | "prepareInstallation" | "resolveGatewayContext"
> & {
  ownerSignal: AbortSignal;
  providerFor: (providerId: string) => WorkerProvider;
  expirePrepared: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord>;
  finishDestroy: ReturnType<typeof createWorkerProviderOwnerLifecycle>["finishDestroy"];
  nodeProvisioning: Pick<ReturnType<typeof createWorkerNodeProvisioning>, "prepare">;
  retireRefusedProvisionSource: (
    record: WorkerEnvironmentRecord,
    error: unknown,
    provider: WorkerProvider,
  ) => Promise<void>;
  finishProvision: (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    signal: AbortSignal,
    installation?: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    nodeRuntimeIdentity?: WorkerNodeRuntimeIdentity,
    beforeProvision?: () => void,
    repositorySource?: WorkerProviderRepositorySource,
    wakeRetained?: () => void,
  ) => Promise<WorkerEnvironmentRecord>;
};

async function failUnallocatedIntent(
  options: Pick<WorkerProviderLifecycleOptions, "store" | "move">,
  record: WorkerEnvironmentRecord,
  error: unknown,
  signal: AbortSignal,
): Promise<never> {
  const current = options.store.get(record.environmentId);
  // Reconciliation must not retry a refused allocation without its live admission.
  // Provisioning rows can already own a paid lease; cancellation owns its teardown.
  if (
    !signal.aborted &&
    current?.state === "requested" &&
    current.provisionOperationId === record.provisionOperationId &&
    current.ownerEpoch === record.ownerEpoch &&
    current.destroyRequestedAtMs === null
  ) {
    await options.move(current, "failed", { lastError: boundedError(error) });
  }
  throw error;
}

/** Restores the original create source before resuming one durable allocation intent. */
export function createWorkerProvisionResumer(options: WorkerProvisionResumeOptions) {
  const {
    store,
    move,
    saveError,
    providerFor,
    expirePrepared,
    finishDestroy,
    nodeProvisioning,
    finishProvision,
    retireRefusedProvisionSource,
  } = options;
  return async (
    record: WorkerEnvironmentRecord,
    provider = providerFor(record.providerId),
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
    repositorySource?: WorkerProviderRepositorySource,
    wakeRetained?: () => void,
    originalSource?: () => void,
  ) => {
    const workSignal = signal
      ? AbortSignal.any([options.ownerSignal, signal])
      : options.ownerSignal;
    const pending = await expirePrepared(record);
    if (pending.destroyRequestedAtMs !== null) {
      return finishDestroy(pending, provider);
    }
    // Shutdown cancels this attempt; only request cancellation records destroy intent.
    const cancellation = signal
      ? createWorkerProvisionCancellation(store, record, signal)
      : undefined;
    if (cancellation) {
      retainProviderSettlement?.(cancellation.settled);
    }
    let source: Awaited<ReturnType<typeof restoreWorkerProvisionSource>>;
    const assertAdmitted = () => {
      source?.assertCurrent();
      beforeProvision?.();
    };
    try {
      source = await restoreWorkerProvisionSource(options, record, workSignal, originalSource);
      assertAdmitted();
      const preparedNode = await nodeProvisioning.prepare(
        record,
        provider,
        workSignal,
        assertAdmitted,
      );
      let installation: WorkerInstallationArtifact | undefined = preparedNode?.installation;
      cancellation?.assertActive();
      if (
        record.state === "requested" &&
        record.destroyRequestedAtMs === null &&
        !installation &&
        provider.provisionBeforeInstallation !== true
      ) {
        try {
          // Fresh requests package before allocation. Once provisioning is durable, provider replay
          // must happen first because the previous response may have been lost after allocation.
          installation = await options.prepareInstallation(
            check.requireInstall(record),
            workSignal,
          );
        } catch (error) {
          cancellation?.assertActive();
          options.ownerSignal.throwIfAborted();
          const detail = boundedError(error);
          await move(record, "failed", { lastError: detail });
          throw serviceError(
            "bootstrap_failure",
            `Worker installation preparation failed: ${detail}`,
          );
        }
        cancellation?.assertActive();
      }
      assertAdmitted();
      return await finishProvision(
        pending,
        provider,
        workSignal,
        installation,
        cancellation,
        preparedNode?.identity,
        assertAdmitted,
        repositorySource,
        wakeRetained,
      );
    } catch (error) {
      await retireRefusedProvisionSource(record, error, provider);
      if (error instanceof WorkerProvisionSourceRecoveryPendingError) {
        await saveError(record, error);
        throw error;
      }
      return await failUnallocatedIntent(options, record, error, workSignal);
    } finally {
      try {
        await cancellation?.close();
      } finally {
        source?.release();
      }
    }
  };
}
