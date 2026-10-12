import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import { DevicePlacementUnavailableError } from "./device-placement-eligibility.js";
import {
  FORCED_WORKER_ABANDONMENT_ERROR,
  projectPlacementTurnClaim,
  type WorkerPlacementExecutionMode,
} from "./placement-record.js";
import type {
  createWorkerSessionPlacementStore,
  WorkerSessionPlacementRecord,
} from "./placement-store.js";
import {
  isFailedWorkerPlacementEnvironmentGone,
  matchesWorkerPlacementTarget,
} from "./placement-target.js";
import type {
  WorkerEnvironmentServiceContract,
  WorkerPlacementAuthorization,
} from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import { isTerminalWorkerEnvironmentState } from "./state.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

export type WorkerDispatchPlacement = WorkerSessionPlacementRecord;
export type WorkerActiveDispatchPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "active" }
>;
type WorkerFailedDispatchPlacement = Extract<WorkerDispatchPlacement, { state: "failed" }>;
export type WorkerProvisioningDispatchPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "provisioning" }
>;
type WorkerDrainingDispatchPlacement = Extract<WorkerDispatchPlacement, { state: "draining" }>;
type WorkerReconcilingDispatchPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "reconciling" }
>;

export type WorkerDispatchPlacementStore = Pick<
  ReturnType<typeof createWorkerSessionPlacementStore>,
  | "adoptActive"
  | "claimReclaimWorkspaceResult"
  | "claimTurn"
  | "closeWorkerTurnToolState"
  | "beginPlacementMove"
  | "cancelPlacementMove"
  | "completePlacementMoveSourceToLocal"
  | "completeAbandonedPlacementMoveSourceToLocal"
  | "completePlacementMoveToWorker"
  | "recordPlacementMoveError"
  | "fail"
  | "get"
  | "getAsync"
  | "getWithMoveAsync"
  | "getPlacementMoveAsync"
  | "readProjection"
  | "readRecoveryCandidates"
  | "readChangeSnapshot"
  | "loadWorkspaceReconciliation"
  | "beginWorkspaceReconciliation"
  | "abortWorkspaceReconciliation"
  | "listWorkspaceReconciliationOwners"
  | "listPendingWorkspaceResultsAsync"
  | "markWorkspaceResultPending"
  | "handoffWorkspaceResultRecovery"
  | "workspaceResultInstanceId"
  | "validateWorkspaceResultClaim"
  | "prepareWorkspaceResultClaim"
  | "preparedWorkspaceResult"
  | "preparedWorkspaceResultPlacement"
  | "recordStagedWorkspaceResult"
  | "recordWorkspaceResultConflict"
  | "acceptWorkspaceResult"
  | "cancelWorkspaceResultAndReleaseTurn"
  | "completeWorkspaceResultAndReleaseTurn"
  | "failWorkspaceResultAndReleaseTurn"
  | "abandonWorkspaceResult"
  | "listForReconcileAsync"
  | "releaseTurn"
  | "retainInterruptedTurnWorkspace"
  | "bindPreparedEnvironment"
  | "startDispatch"
  | "startDrain"
  | "startWorkspaceResultDrain"
  | "startReconcile"
  | "transition"
  | "updateWorkspaceBaseManifest"
>;

export type WorkerDispatchEnvironmentService = Pick<
  WorkerEnvironmentService,
  | "attachSession"
  | "bindPreparedWorkspace"
  | "prepareProjectIntent"
  | "assertPreparedIntentCurrent"
  | "getPreparedCandidates"
  | "schedulePreparedRefill"
  | "createWithRequest"
  | "destroy"
  | "get"
  | "fenceWorkerTurnForRecovery"
  | "reconcileEnvironment"
  | "reconcileOnce"
  | "startTunnel"
  | "stopTunnel"
  | "supportsProviderExecutionMode"
>;

export type WorkerActivationBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementExecutionMode;
  authorize?: WorkerPlacementAuthorization;
  signal?: AbortSignal;
  activate: (assertCurrent?: () => void) => Promise<WorkerActiveDispatchPlacement>;
}) => Promise<WorkerActiveDispatchPlacement>;

const RECOVERY_ERROR_LIMIT = 1_024;
const log = createSubsystemLogger("gateway/worker-placement");

export function canRetryDeviceDispatch(params: {
  error: unknown;
  deviceId: string;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  attempted: WorkerDispatchPlacement | undefined;
  current: WorkerDispatchPlacement | undefined;
  environments: Pick<WorkerEnvironmentServiceContract, "get"> | undefined;
}): boolean {
  const { error, attempted, current } = params;
  // Startup alone attests that workspace work never began. Cleanup must settle
  // for that exact failed generation before Auto selects another host.
  return (
    error instanceof DevicePlacementUnavailableError &&
    error.deviceId === params.deviceId &&
    current?.state === "failed" &&
    attempted?.state === "failed" &&
    current.generation === attempted.generation &&
    current.environmentId === attempted.environmentId &&
    current.sessionId === params.sessionId &&
    current.sessionKey === params.sessionKey &&
    current.agentId === params.agentId &&
    isFailedWorkerPlacementEnvironmentGone({
      environmentService: params.environments,
      placement: current,
    })
  );
}

export function workerDisappearanceError(
  environment: ReturnType<WorkerEnvironmentService["get"]>,
): Error | undefined {
  if (!environment) {
    return new Error("cloud worker disappeared: environment record missing");
  }
  if (!isTerminalWorkerEnvironmentState(environment.state)) {
    return undefined;
  }
  return new Error(
    `cloud worker disappeared: ${environment.error ?? `environment state ${environment.state}`}`,
  );
}

export function isUnavailableEnvironment(
  environment: NonNullable<ReturnType<WorkerEnvironmentService["get"]>>,
): boolean {
  return (
    environment.state === "draining" ||
    environment.state === "destroying" ||
    isTerminalWorkerEnvironmentState(environment.state)
  );
}

export function createPlacementFailureActions(deps: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
}) {
  const { environments, placements } = deps;

  const updateFailure = (
    placement: WorkerDispatchPlacement,
    error: unknown,
    teardownErrors?: readonly string[],
    assertCurrent?: () => void,
  ): Promise<WorkerDispatchPlacement> => {
    let recoveryError = boundedError(error);
    if (teardownErrors) {
      recoveryError = boundedError(
        truncateUtf16Safe([recoveryError, ...teardownErrors].join("; "), RECOVERY_ERROR_LIMIT),
      );
    }
    return placements.fail(
      {
        sessionId: placement.sessionId,
        expectedGeneration: placement.generation,
        recoveryError,
      },
      assertCurrent,
    );
  };

  const cleanupEnvironment = async (params: {
    environmentId: string;
    ownerEpoch: number | null;
    authorize?: WorkerPlacementAuthorization;
  }): Promise<string[]> => {
    const teardownErrors: string[] = [];
    params.authorize?.();
    try {
      await environments.stopTunnel(params.environmentId, params.ownerEpoch ?? undefined);
    } catch (error) {
      teardownErrors.push(`tunnel stop: ${boundedError(error)}`);
    }
    params.authorize?.();
    try {
      await environments.destroy(params.environmentId);
    } catch (error) {
      teardownErrors.push(`environment destroy: ${boundedError(error)}`);
    }
    return teardownErrors;
  };

  const teardownEnvironment = async (params: {
    placement: WorkerDispatchPlacement;
    environmentId: string | null;
    ownerEpoch: number | null;
    primaryError: unknown;
  }): Promise<WorkerDispatchPlacement> => {
    const environmentId = params.environmentId;
    const teardownErrors = environmentId
      ? await cleanupEnvironment({
          environmentId,
          ownerEpoch: params.ownerEpoch,
        })
      : [];
    return updateFailure(params.placement, params.primaryError, teardownErrors);
  };

  const cancelProvisioning = (
    placement: WorkerDispatchPlacement | undefined,
    expected: WorkerDispatchPlacement | undefined,
    assertCurrent?: () => void,
  ): Promise<WorkerDispatchPlacement> => {
    // Idle recovery has no admission to interrupt. Its Stop must claim only the captured
    // provisioning tuple before using the ordinary failed-environment cleanup path.
    if (expected?.state !== "provisioning" || !matchesWorkerPlacementTarget(placement, expected)) {
      throw new Error("Provisioning cloud worker placement changed during reclaim");
    }
    return updateFailure(
      expected,
      new Error("Cloud worker provisioning canceled"),
      undefined,
      assertCurrent,
    );
  };

  const retryFailedTeardown = async (
    placement: WorkerFailedDispatchPlacement,
    authorize?: WorkerPlacementAuthorization,
  ): Promise<string | undefined> => {
    if (!placement.environmentId) {
      return undefined;
    }
    const environment = environments.get(placement.environmentId);
    if (!environment || isTerminalWorkerEnvironmentState(environment.state)) {
      return undefined;
    }
    const teardownErrors = await cleanupEnvironment({
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      ...(authorize ? { authorize } : {}),
    });
    // Forced abandonment is a committed decision used by Continue on Gateway. Retrying
    // physical cleanup must not replace that decision or advance its placement generation.
    if (teardownErrors.length > 0 && placement.recoveryError !== FORCED_WORKER_ABANDONMENT_ERROR) {
      // The terminal cause is immutable; composing from retry output grows a new
      // cleanup suffix on every sweep and eventually hides the latest diagnosis.
      const originalError = placement.terminalReason ?? placement.recoveryError;
      const recoveryError = boundedError(
        [originalError, ...teardownErrors.filter((detail) => !originalError.includes(detail))]
          .filter(Boolean)
          .join("; "),
        RECOVERY_ERROR_LIMIT,
      );
      if (recoveryError !== placement.recoveryError) {
        // Settle the admitted teardown even if caller authority closed during destroy.
        await placements.fail({
          sessionId: placement.sessionId,
          expectedGeneration: placement.generation,
          recoveryError,
        });
      }
    }
    // The persisted failure may intentionally retain an earlier terminal cause.
    return teardownErrors.length > 0 ? boundedError(teardownErrors.join("; ")) : undefined;
  };

  const startDrain = async (
    placement: WorkerActiveDispatchPlacement,
  ): Promise<WorkerDrainingDispatchPlacement> => {
    const draining = await placements.startDrain({
      sessionId: placement.sessionId,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      expectedGeneration: placement.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("Worker placement drain did not produce a draining placement");
    }
    return draining;
  };

  const startReconcile = async (
    placement: WorkerDrainingDispatchPlacement,
  ): Promise<WorkerReconcilingDispatchPlacement> => {
    const reconciling = await placements.startReconcile({
      sessionId: placement.sessionId,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      expectedGeneration: placement.generation,
    });
    if (reconciling.state !== "reconciling") {
      throw new Error("Worker placement reconcile did not produce a reconciling placement");
    }
    return reconciling;
  };

  const failDraining = async (
    placement: WorkerDrainingDispatchPlacement,
    error: unknown,
    options: { forceClaimFence?: boolean } = {},
  ): Promise<void> => {
    if (placement.turnClaim && !options.forceClaimFence) {
      // Draining closes new admission. The admitted turn still owns result
      // reconciliation; startup recovery explicitly fences stale claims.
      return;
    }
    const current = await placements.getAsync(placement.sessionId);
    if (current?.state !== "draining") {
      return;
    }
    const claim = projectPlacementTurnClaim(current);
    if (claim) {
      await placements.closeWorkerTurnToolState(claim);
    }
    const reconciling = await startReconcile(current);
    const teardownErrors = await cleanupEnvironment({
      environmentId: current.environmentId,
      ownerEpoch: current.activeOwnerEpoch,
    });
    await updateFailure(reconciling, error, teardownErrors);
  };

  const reclaimActive = async (
    placement: WorkerActiveDispatchPlacement,
    environment: ReturnType<WorkerEnvironmentService["get"]>,
    claimedTurnError: Error,
  ): Promise<void> => {
    const draining = await startDrain(placement);
    if (draining.turnClaim) {
      await failDraining(draining, claimedTurnError, { forceClaimFence: true });
      return;
    }
    const reconciling = await startReconcile(draining);
    if (
      environment?.state === "failed" &&
      environment.error === STALE_WORKER_BUILD_REASON &&
      environment.leaseId === null &&
      !(await placements.listPendingWorkspaceResultsAsync(placement.sessionId)).some(
        (result) => result.sessionId === placement.sessionId,
      )
    ) {
      // Retained conflict reports and staged refs survive redispatch; only pending results
      // block idle retirement. Reclaim and publication still consult retained conflicts.
      await placements.transition({
        sessionId: reconciling.sessionId,
        from: "reconciling",
        to: "reclaimed",
        expectedGeneration: reconciling.generation,
      });
      log.info(
        `Reclaimed idle cloud worker sessionId=${boundedError(placement.sessionId, 128)} environmentId=${boundedError(placement.environmentId, 128)}: ${STALE_WORKER_BUILD_REASON}`,
      );
      return;
    }
    if (!environment || isTerminalWorkerEnvironmentState(environment.state)) {
      await updateFailure(reconciling, claimedTurnError, []);
      return;
    }
    // Draining and destroying close execution authority, not the provider lease.
    // Reclaim is complete only after the pending teardown succeeds.
    const teardownErrors = await cleanupEnvironment({
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
    });
    if (teardownErrors.length > 0) {
      await updateFailure(
        reconciling,
        new Error(`Worker reclaim teardown failed: ${teardownErrors.join("; ")}`),
        [],
      );
      return;
    }
    await placements.transition({
      sessionId: reconciling.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
  };

  const failActive = async (
    placement: WorkerActiveDispatchPlacement,
    error: unknown,
    options: { forceClaimFence?: boolean } = {},
  ): Promise<void> => {
    const draining = await startDrain(placement);
    await failDraining(draining, error, options);
  };

  return {
    cancelProvisioning,
    failActive,
    failDraining,
    reclaimActive,
    retryFailedTeardown,
    teardownEnvironment,
  };
}

export type PlacementFailureActions = ReturnType<typeof createPlacementFailureActions>;
