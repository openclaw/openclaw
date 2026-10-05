import { WorkerProviderError, type WorkerProvider } from "../../plugins/types.js";
import {
  WorkerEnvironmentCapacityError,
  workerEnvironmentServiceError as serviceError,
} from "./environment-errors.js";
import {
  isWorkerRecoveryDisposalSettled,
  type WorkerEnvironmentRecord,
} from "./environment-record.js";
import { recordWorkerPlacementStage } from "./placement-diagnostics.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import {
  isNeverActivatedWorkerPlacement,
  isFencedPreactivationEnvironment,
  type WorkerPreactivationRetirement,
} from "./placement-target.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { RetainedWorkerRecoveryAcceptance } from "./recovery-hold-store.js";
import {
  usesRepositoryRefWorkerRecovery,
  requireProviderOperationTimeoutMs,
  requireWorkerProfile,
} from "./service-validation.js";
import type { WorkerEnvironmentStore } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";

/** Bind the provider's settled rejection before adopting cleanup. */
export async function prepareWorkerCapacitySettlement(
  record: WorkerEnvironmentRecord,
  provider: WorkerProvider,
  error: ReturnType<typeof WorkerProviderError.capacityShortage>,
  readCurrent: () => WorkerEnvironmentRecord,
): Promise<() => void> {
  const check = () => {
    const current = readCurrent();
    if (
      current.provisionOperationId !== error.receipt.operationId ||
      current.destroyRequestedAtMs !== null
    ) {
      throw serviceError("invalid_state", "Worker shortage operation changed before settlement");
    }
  };
  check();
  const allocation = await provider.resolveAllocation(
    requireWorkerProfile(record.profileSnapshot.settings),
    record.provisionOperationId,
  );
  check();
  if (allocation.leaseId !== error.receipt.leaseId || allocation.sharedHost) {
    throw serviceError("provider_failure", "Worker shortage does not match its fixed allocation");
  }
  return check;
}

/** The existing provider effect and its held-resource receipt share exact owner custody. */
export async function destroyWorkerProviderLease(
  options: Pick<
    WorkerProviderLifecycleOptions,
    "store" | "callProvider" | "providerCallTimeoutMs"
  > & {
    record: WorkerEnvironmentRecord;
    provider: WorkerProvider;
    lease: Parameters<WorkerProvider["destroy"]>[0];
    requireCurrentOwner: (record: WorkerEnvironmentRecord) => WorkerEnvironmentRecord;
  },
): Promise<WorkerEnvironmentRecord> {
  const { record, provider, lease, requireCurrentOwner } = options;
  requireCurrentOwner(record);
  if (record.recoveryHold?.cleanup?.providerReleasedAtMs !== undefined) {
    return record;
  }
  const timeoutMs =
    options.providerCallTimeoutMs === undefined
      ? requireProviderOperationTimeoutMs(
          "destroy",
          provider.resolveDestroyTimeoutMs?.(lease.profile),
        )
      : undefined;
  await options.callProvider(
    record.environmentId,
    () => {
      // An earlier timed-out operation can keep this call queued across owner changes.
      requireCurrentOwner(record);
      return provider.destroy(lease);
    },
    timeoutMs,
  );
  requireCurrentOwner(record);
  if (!record.recoveryHold) {
    return record;
  }
  // Enrollment retirement may still fail. Persist known release so that restart does
  // not repeat a settled provider effect; the hold remains charged until finalization.
  return await options.store.requestDestroy({
    environmentId: record.environmentId,
    state: record.state,
    providerRelease: { leaseId: lease.leaseId, ownerEpoch: record.ownerEpoch },
    assertCurrent: () => {
      requireCurrentOwner(record);
    },
  });
}

/** Keep logical cutover behind confirmed physical disposal and fresh caller admission. */
export async function completeRetainedWorkerRecovery(
  store: WorkerEnvironmentStore,
  destroy: (environmentId: string) => Promise<WorkerEnvironmentRecord>,
  input: RetainedWorkerRecoveryAcceptance & { assertCurrent?: () => void },
) {
  const started = performance.now();
  const staged = await store.acceptRetainedRecovery(input);
  const facts = { environmentId: input.environmentId, generation: staged.generation };
  if (staged.state === "reclaimed") {
    recordWorkerPlacementStage(input.sessionId, "recovery_checkpoint_accepted", facts);
    return staged;
  }
  input.assertCurrent?.();
  recordWorkerPlacementStage(input.sessionId, "recovery_disposal_staged", {
    ...facts,
    certainty: "unknown",
  });
  try {
    const settled = await destroy(input.environmentId);
    if (!isWorkerRecoveryDisposalSettled(settled)) {
      throw new Error("Failed worker disposal is not yet confirmed");
    }
    recordWorkerPlacementStage(input.sessionId, "recovery_disposal_settled", {
      ...facts,
      certainty: "confirmed",
      elapsedMs: performance.now() - started,
    });
  } catch (error) {
    recordWorkerPlacementStage(input.sessionId, "recovery_disposal_pending", {
      ...facts,
      certainty: "unknown",
      elapsedMs: performance.now() - started,
    });
    throw error;
  }
  input.assertCurrent?.();
  if (input.disposalOnly) {
    return staged;
  }
  const accepted = await store.acceptRetainedRecovery(input);
  if (accepted.state !== "reclaimed") {
    throw new Error("Retained worker cutover still requires physical settlement");
  }
  recordWorkerPlacementStage(input.sessionId, "recovery_checkpoint_accepted", {
    ...facts,
    generation: accepted.generation,
    certainty: "confirmed",
  });
  return accepted;
}

export async function finishConfirmedProvisionCleanup(
  record: WorkerEnvironmentRecord,
  error: ReturnType<typeof WorkerProviderError.cleanupComplete>,
  operations: {
    store: WorkerEnvironmentStore;
    stopOwner: (
      record: WorkerEnvironmentRecord,
      reason: "provider-destroyed",
    ) => Promise<WorkerEnvironmentRecord>;
    finishProvenDestroy: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord>;
  },
  assertCurrent?: () => void,
): Promise<never> {
  const { store, stopOwner, finishProvenDestroy } = operations;
  const current = store.get(record.environmentId);
  // Enrollment may bind a node while this same provisioning operation is awaiting cleanup.
  if (
    !current ||
    current.provisionOperationId !== record.provisionOperationId ||
    current.ownerEpoch !== record.ownerEpoch
  ) {
    throw serviceError("invalid_state", "Worker provisioning owner changed during cleanup");
  }
  const detail = boundedWorkerError(error.provisionError);
  const shortage = WorkerProviderError.isCapacityShortage(error.provisionError)
    ? error.provisionError
    : undefined;
  assertCurrent?.();
  const destroying = await store.adoptProvisionCleanupFailure({
    environmentId: record.environmentId,
    leaseId: error.leaseId,
    lastError: detail,
    ...(shortage ? { terminalState: "destroyed" as const } : {}),
    assertCurrent,
  });
  const settled = await finishProvenDestroy(await stopOwner(destroying, "provider-destroyed"));
  if (shortage && settled.state === "destroyed") {
    throw new WorkerEnvironmentCapacityError(
      {
        environmentId: settled.environmentId,
        ownerEpoch: settled.ownerEpoch,
        provisionOperationId: settled.provisionOperationId,
        providerId: settled.providerId,
        profileId: settled.profileId,
      },
      shortage.receipt,
    );
  }
  throw serviceError("provider_failure", `Worker provider operation failed: ${detail}`);
}

export async function preserveIndeterminateProvisionCleanup(
  record: WorkerEnvironmentRecord,
  error: ReturnType<typeof WorkerProviderError.cleanupIndeterminate>,
  store: WorkerEnvironmentStore,
): Promise<never> {
  // Split the durable diagnostic budget so neither the allocation failure nor its cleanup
  // failure can erase the other before restart reconciliation.
  const provisionDetail = boundedWorkerError(error.provisionError, 480);
  const cleanupDetail = boundedWorkerError(error.cleanupError, 480);
  const detail = `${provisionDetail}; provider teardown pending: ${cleanupDetail}`;
  await store.adoptProvisionCleanupFailure({
    environmentId: record.environmentId,
    leaseId: error.leaseId,
    lastError: detail,
  });
  throw serviceError(
    "provider_failure",
    `Worker provider operation failed; teardown is pending: ${detail}`,
  );
}

/** Release only a never-admitted session; the old allocation still owns cleanup and capacity. */
export async function retireWorkerPreactivation(
  options: Pick<
    WorkerProviderLifecycleOptions,
    "store" | "withLock" | "getConfig" | "retireNodeEnrollment" | "isStopping"
  > & {
    joinProvider: (environmentId: string) => Promise<void>;
    stopOwner: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord>;
  },
  placement: Extract<WorkerSessionPlacementRecord, { state: "failed" }>,
  accept: (
    receipt: WorkerPreactivationRetirement,
    assertCurrent: () => void,
  ) => Promise<WorkerSessionPlacementRecord>,
  authorize?: () => void,
): Promise<WorkerSessionPlacementRecord | undefined> {
  if (!isNeverActivatedWorkerPlacement(placement) || !placement.environmentId) {
    return undefined;
  }
  const environmentId = placement.environmentId;
  return await options.withLock(environmentId, async () => {
    authorize?.();
    const original = options.store.get(environmentId);
    if (
      !original ||
      !isFencedPreactivationEnvironment(original) ||
      !usesRepositoryRefWorkerRecovery(options.getConfig(), original)
    ) {
      return undefined;
    }
    const assertCurrent = () => {
      authorize?.();
      const current = options.store.get(environmentId);
      if (
        options.isStopping() ||
        !current ||
        !isFencedPreactivationEnvironment(current) ||
        current.ownerEpoch !== original.ownerEpoch ||
        current.provisionOperationId !== original.provisionOperationId ||
        current.nodeSetupId !== original.nodeSetupId ||
        !usesRepositoryRefWorkerRecovery(options.getConfig(), current)
      ) {
        throw new Error("Failed preactivation environment changed before retirement");
      }
    };
    // The environment lock joins its local continuation; the provider queue retains
    // the real child across timeouts. Neither an RPC timeout nor inventory absence joins it.
    await options.joinProvider(environmentId);
    assertCurrent();
    if (original.nodeSetupId && !options.retireNodeEnrollment) {
      throw new Error("Worker enrollment retirement is unavailable");
    }
    await options.retireNodeEnrollment?.(original);
    assertCurrent();
    await options.stopOwner(original);
    assertCurrent();
    const receipt = {
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      environmentId,
      ownerEpoch: original.ownerEpoch,
      provisionOperationId: original.provisionOperationId,
      nodeSetupId: original.nodeSetupId,
    };
    // Only placement custody changes. The old allocation and capacity charge remain
    // destroy-requested under their existing cleanup owner, even after a fresh dispatch.
    return await accept(receipt, assertCurrent);
  });
}
