import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import {
  DEFAULT_RECOVERY_DELAY_MS,
  mainSessionRecoveryLog,
} from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { resolveDeviceWorkerAvailability } from "./device-provider.js";
import { WorkerEnvironmentCapacityError } from "./environment-errors.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  matchesWorkerPlacementTarget,
  isWorkerPlacementDestroyedBeforeActivation,
} from "./placement-target.js";
import type { PlacementTurnClaimAuthority } from "./placement-turn-authority.js";
import { WorkerRunnerUnavailableError, type WorkerCapacityRefusal } from "./tunnel-contract.js";
import type { WorkerTurnEnvironmentService } from "./worker-turn-failure.js";

export type RecoveryWorkerRetryIntent = {
  assertCurrent: (assertRunCurrent: () => void) => Promise<void>;
  release: () => void | Promise<void>;
};

/** Admission consumes either ordinary dispatch or this owner's settled shortage wait. */
export async function redispatchWithRecoveryCapacity(
  params: Omit<Parameters<typeof waitForRecoveryProviderCapacity>[0], "shortage" | "placement"> & {
    sessionId: string;
    dispatch: () => Promise<Extract<WorkerSessionPlacementRecord, { state: "active" }>>;
  },
) {
  try {
    return { placement: await params.dispatch(), retryIntent: undefined };
  } catch (error) {
    if (!(error instanceof WorkerEnvironmentCapacityError)) {
      throw error;
    }
    params.assertCurrent();
    const failed = params.placements.get(params.sessionId);
    if (failed?.state !== "failed") {
      throw new Error("Provider shortage has no settled failed placement", { cause: error });
    }
    const retryIntent = await waitForRecoveryProviderCapacity({
      ...params,
      shortage: error,
      placement: failed,
    });
    if (!retryIntent) {
      throw error;
    }
    return { placement: failed, retryIntent };
  }
}

/** The failed operation is already settled; wait outside allocator/placement mutexes. */
export async function waitForRecoveryProviderCapacity(params: {
  environments: Pick<WorkerTurnEnvironmentService, "get">;
  placements: Pick<WorkerSessionPlacementStore, "get" | "prepareRuntimeRefresh">;
  shortage: WorkerEnvironmentCapacityError;
  placement: WorkerSessionPlacementRecord;
  runId: string;
  turn: Pick<SessionPlacementTurnParams, "sessionTarget" | "lifecycleGeneration" | "abortSignal">;
  assertCurrent: () => void;
}): Promise<RecoveryWorkerRetryIntent | false> {
  const scope = params.turn.sessionTarget;
  if (!scope?.sessionKey || !scope.storePath) {
    return false;
  }
  const prepared = await params.placements.prepareRuntimeRefresh(params.placement.sessionId);
  let databaseClaim:
    | Awaited<ReturnType<typeof loadSessionEntryForAdmission>>["databaseClaim"]
    | undefined;
  let releaseWait: (() => void) | undefined;
  let transferred = false;
  let waiting = false;
  const assertPlacementCurrent = () => {
    params.turn.abortSignal?.throwIfAborted();
    params.assertCurrent();
    prepared.assertCurrent();
    const current = params.placements.get(params.placement.sessionId);
    const environment = params.environments.get(params.shortage.environment.environmentId);
    if (
      !matchesWorkerPlacementTarget(current, params.placement) ||
      !current ||
      current.sessionKey !== scope.sessionKey ||
      current.agentId !== scope.agentId ||
      !isWorkerPlacementDestroyedBeforeActivation(current, environment) ||
      environment?.ownerEpoch !== params.shortage.environment.ownerEpoch ||
      environment.leaseId !== params.shortage.receipt.leaseId ||
      params.shortage.environment.provisionOperationId !== params.shortage.receipt.operationId
    ) {
      throw new Error("Provider capacity wait lost its exact settled placement");
    }
    databaseClaim?.assertCurrent();
  };
  let wait:
    | Extract<
        import("../../agents/main-session-recovery/main-session-recovery-types.js").MainSessionRecoveryCommand,
        { kind: "cancel_capacity_wait" }
      >["wait"]
    | undefined;
  let target: { agentId?: string; sessionKey: string; storePath: string } | undefined;
  try {
    assertPlacementCurrent();
    const physical = await prepareSqliteTargetFromSessionStorePath(
      scope.storePath,
      { agentId: scope.agentId },
      params.turn.abortSignal,
    );
    assertPlacementCurrent();
    target = { agentId: scope.agentId, sessionKey: scope.sessionKey, storePath: physical.path };
    const admitted = await loadSessionEntryForAdmission(target, {
      signal: params.turn.abortSignal,
      assertCurrent: assertPlacementCurrent,
    });
    databaseClaim = admitted.databaseClaim;
    assertPlacementCurrent();
    const lifecycleGeneration =
      params.turn.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
    const state = admitted.entry?.mainRestartRecovery;
    if (
      !state ||
      admitted.entry?.sessionId !== params.placement.sessionId ||
      admitted.entry.lifecycleRunId !== params.runId ||
      !admitted.entry.restartRecoveryRuns?.some(
        (run) => run.runId === params.runId && run.lifecycleGeneration === lifecycleGeneration,
      )
    ) {
      return false;
    }
    const decision = {
      sessionId: params.placement.sessionId,
      cycleId: state.cycleId,
      runId: params.runId,
      lifecycleGeneration,
      lifecycleRevision: admitted.entry.lifecycleRevision,
      provider: {
        kind: "settled-shortage-v1" as const,
        ...params.shortage.receipt,
        environmentId: params.shortage.environment.environmentId,
        ownerEpoch: params.shortage.environment.ownerEpoch,
        providerId: params.shortage.environment.providerId,
        profileId: params.shortage.environment.profileId,
        placementGeneration: params.placement.generation,
        attempt: state.chargedAttempts,
      },
    };
    wait = decision;
    const marked = await commitMainSessionRecovery({
      target,
      command: { kind: "wait_provider_capacity", ...decision, now: Date.now() },
      assertCommitAllowed: assertPlacementCurrent,
      requireWriteSuccess: true,
    });
    if (marked.transition.kind !== "applied" && marked.transition.kind !== "no_change") {
      throw new Error("Provider capacity wait lost its current recovery intent");
    }
    waiting = true;
    releaseWait = registerAgentRunCapacityWait(params.runId, lifecycleGeneration);
    await sleepWithAbort(DEFAULT_RECOVERY_DELAY_MS, params.turn.abortSignal, { ref: false });
    assertPlacementCurrent();
    const finished = await commitMainSessionRecovery({
      target,
      command: { kind: "finish_provider_capacity", ...decision, now: Date.now() },
      assertCommitAllowed: assertPlacementCurrent,
      requireWriteSuccess: true,
    });
    if (finished.transition.kind !== "applied") {
      throw new Error("Provider capacity retry lost its current recovery intent");
    }
    waiting = false;
    assertPlacementCurrent();
    const retainedDatabase = databaseClaim;
    const retainedTarget = target;
    transferred = true;
    return {
      assertCurrent: async (assertRunCurrent) => {
        const check = () => {
          params.turn.abortSignal?.throwIfAborted();
          retainedDatabase.assertCurrent();
          assertRunCurrent();
        };
        const validated = await commitMainSessionRecovery({
          target: retainedTarget,
          command: { kind: "validate_provider_recovery", ...decision, now: Date.now() },
          assertCommitAllowed: check,
          requireWriteSuccess: true,
        });
        check();
        if (validated.transition.kind !== "no_change") {
          throw new Error("Provider recovery intent changed before allocation or launch");
        }
      },
      release: () => retainedDatabase.release(),
    };
  } finally {
    try {
      if (waiting && wait && target) {
        await repairMainSessionRecoveryMutation({
          mutation: () =>
            commitMainSessionRecovery({
              target: target!,
              command: { kind: "cancel_capacity_wait", wait: wait! },
              requireWriteSuccess: true,
            }),
          onDeferredSuccess: () => {},
          onError: () =>
            mainSessionRecoveryLog.warn("Failed to clear provider recovery capacity wait"),
        });
      }
    } finally {
      releaseWait?.();
      prepared.release();
      if (!transferred) {
        await databaseClaim?.release();
      }
    }
  }
}

/** Wait before execution, retaining one claim rather than allocating or launching a second child. */
export async function waitForRecoveryWorkerCapacity(params: {
  environments: object;
  placements: Pick<WorkerSessionPlacementStore, "prepareTurnClaimAuthority">;
  refusal: WorkerCapacityRefusal;
  claim: WorkerSessionTurnClaim;
  turn: Pick<SessionPlacementTurnParams, "sessionTarget" | "lifecycleGeneration" | "abortSignal">;
  assertCurrent: () => void;
}): Promise<RecoveryWorkerRetryIntent | false> {
  params.assertCurrent();
  const first = await resolveDeviceWorkerAvailability(
    params.environments,
    params.refusal.nodeDeviceId,
  );
  params.assertCurrent();
  const node = first.node;
  if (
    !first.available ||
    first.issue ||
    !node ||
    node.connId !== params.refusal.connId ||
    node.pairingGeneration !== params.refusal.pairingGeneration
  ) {
    throw new WorkerRunnerUnavailableError();
  }
  const scope = params.turn.sessionTarget;
  if (!scope?.sessionKey || !scope.storePath || params.claim.owner.kind !== "worker") {
    return false;
  }
  if (
    params.refusal.sessionId !== params.claim.sessionId ||
    params.refusal.runId !== params.claim.runId ||
    params.refusal.environmentId !== params.claim.owner.environmentId ||
    params.refusal.ownerEpoch !== params.claim.owner.ownerEpoch ||
    params.refusal.placementGeneration !== params.claim.placementGeneration
  ) {
    throw new Error("Worker capacity refusal does not match its exact native turn");
  }
  const physicalTarget = await prepareSqliteTargetFromSessionStorePath(
    scope.storePath,
    { agentId: scope.agentId },
    params.turn.abortSignal,
  );
  params.assertCurrent();
  const target = {
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    storePath: physicalTarget.path,
  };
  const admitted = await loadSessionEntryForAdmission(target, {
    signal: params.turn.abortSignal,
    assertCurrent: params.assertCurrent,
  });
  const lifecycleGeneration = params.turn.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const state = admitted.entry?.mainRestartRecovery;
  if (
    !state ||
    admitted.entry?.sessionId !== params.claim.sessionId ||
    admitted.entry.lifecycleRunId !== params.claim.runId ||
    !admitted.entry.restartRecoveryRuns?.some(
      (run) => run.runId === params.claim.runId && run.lifecycleGeneration === lifecycleGeneration,
    )
  ) {
    await admitted.databaseClaim.release();
    return false;
  }
  const wait = {
    sessionId: params.claim.sessionId,
    cycleId: state.cycleId,
    runId: params.claim.runId,
    lifecycleGeneration,
    lifecycleRevision: admitted.entry.lifecycleRevision,
    worker: {
      environmentId: params.claim.owner.environmentId,
      ownerEpoch: params.claim.owner.ownerEpoch,
      placementGeneration: params.claim.placementGeneration,
      claimId: params.claim.claimId,
      nodeDeviceId: params.refusal.nodeDeviceId,
      connId: node.connId,
      pairingGeneration: node.pairingGeneration,
      launchId: params.refusal.launchId,
      planHash: params.refusal.planHash,
      attempt: state.chargedAttempts,
    },
  };
  let authority: PlacementTurnClaimAuthority | undefined;
  const assertCurrent = () => {
    params.turn.abortSignal?.throwIfAborted();
    params.assertCurrent();
    admitted.databaseClaim.assertCurrent();
    if (authority && !authority.isCurrent()) {
      throw new Error("Worker capacity wait lost its exact turn claim");
    }
  };
  let waiting = false;
  let transferred = false;
  let releaseWait: (() => void) | undefined;
  try {
    authority = await params.placements.prepareTurnClaimAuthority(params.claim);
    assertCurrent();
    for (;;) {
      const marked = await commitMainSessionRecovery({
        target,
        command: { kind: "wait_worker_capacity", ...wait, now: Date.now() },
        assertCommitAllowed: assertCurrent,
        requireWriteSuccess: true,
      });
      if (marked.transition.kind !== "applied" && marked.transition.kind !== "no_change") {
        throw new Error("Worker capacity wait lost its current recovery intent");
      }
      waiting = true;
      releaseWait ??= registerAgentRunCapacityWait(params.claim.runId, lifecycleGeneration);
      await sleepWithAbort(DEFAULT_RECOVERY_DELAY_MS, params.turn.abortSignal, { ref: false });
      assertCurrent();
      const current = await resolveDeviceWorkerAvailability(
        params.environments,
        params.refusal.nodeDeviceId,
      );
      assertCurrent();
      if (
        !current.available ||
        current.issue ||
        !current.node ||
        current.node.nodeId !== node.nodeId ||
        current.node.connId !== node.connId ||
        current.node.pairingGeneration !== node.pairingGeneration
      ) {
        // Loss or replacement is not capacity proof; return to canonical reconciliation.
        throw new WorkerRunnerUnavailableError();
      }
      if (current.node.workerHost.capacity.available <= 0) {
        continue;
      }
      // Recheck human intent at the final owning write, after the availability await.
      const finished = await commitMainSessionRecovery({
        target,
        command: { kind: "finish_worker_capacity", ...wait, now: Date.now() },
        assertCommitAllowed: assertCurrent,
        requireWriteSuccess: true,
      });
      if (finished.transition.kind !== "applied") {
        throw new Error("Worker capacity became available after recovery intent changed");
      }
      // No cleanup await may follow this final intent decision on the success path.
      waiting = false;
      assertCurrent();
      transferred = true;
      return {
        assertCurrent: async (assertRunCurrent) => {
          const assertIntentOwnerCurrent = () => {
            params.turn.abortSignal?.throwIfAborted();
            admitted.databaseClaim.assertCurrent();
            assertRunCurrent();
          };
          const validated = await commitMainSessionRecovery({
            target,
            command: { kind: "validate_worker_recovery", ...wait, now: Date.now() },
            assertCommitAllowed: assertIntentOwnerCurrent,
            requireWriteSuccess: true,
          });
          assertIntentOwnerCurrent();
          if (validated.transition.kind !== "no_change") {
            throw new Error("Worker recovery intent changed before launch");
          }
        },
        release: () => admitted.databaseClaim.release(),
      };
    }
  } finally {
    try {
      if (waiting) {
        await repairMainSessionRecoveryMutation({
          mutation: () =>
            commitMainSessionRecovery({
              target,
              command: { kind: "cancel_capacity_wait", wait },
              requireWriteSuccess: true,
            }),
          onDeferredSuccess: () => {},
          onError: () =>
            mainSessionRecoveryLog.warn("Failed to clear worker recovery capacity wait"),
        });
      }
    } finally {
      releaseWait?.();
      authority?.release();
      if (!transferred) {
        await admitted.databaseClaim.release();
      }
    }
  }
}
