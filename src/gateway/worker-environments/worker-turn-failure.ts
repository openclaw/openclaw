import { logWarn } from "../../logger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { WORKER_ADMISSION_DEADLINE_MS } from "../../worker/worker-connection-contract.js";
import { WorkerNodeLostError } from "../../worker/worker-node-loss.js";
import { reportPlacementTransition } from "./placement-record.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import { matchesWorkerPlacementTarget } from "./placement-target.js";
import { findPendingWorkerWorkspaceResult } from "./placement-workspace-result.js";
import type { WorkerEnvironmentService } from "./service.js";
import { boundedWorkerError } from "./worker-error.js";
import { releaseClaimIfOwned, type WorkerTurnAdmissionOptions } from "./worker-turn-admission.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";

export type WorkerTurnEnvironmentService = Pick<
  WorkerEnvironmentService,
  | "acknowledgeCredentialDelivery"
  | "acquireTurnCredential"
  | "destroy"
  | "get"
  | "startTunnel"
  | "stopTunnel"
> &
  Partial<
    Pick<
      WorkerEnvironmentService,
      | "resolveSshIdentity"
      | "supportsNodePortal"
      | "prepareComputer"
      | "readRuntimeRefresh"
      | "createGatewayTools"
    >
  >;

export type ActiveWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;
export type WorkerTurnPartialIdentity = Pick<WorkerSessionTurnClaim, "sessionId" | "runId"> &
  Pick<ActiveWorkerPlacement, "sessionKey" | "agentId"> & { missingToolResultText?: string };

export class WorkerTurnExecutionError extends Error {}

export class WorkerWorkspaceReconciliationError extends Error {
  override name = "WorkerWorkspaceReconciliationError";
}

// Journal-terminal launches get a short cleanup grace before failure is surfaced.
// This never limits a live launch or a turn still holding its claim.
const TERMINAL_WORKER_CLEANUP_GRACE_MS = 30_000;

export async function prepareWorkerTurnFailure(
  options: WorkerTurnAdmissionOptions & { environments: WorkerTurnEnvironmentService },
  placement: ActiveWorkerPlacement,
  claim: WorkerTurnPartialIdentity & WorkerSessionTurnClaim,
  error: unknown,
  assertCurrent: () => void,
  abortSignal: AbortSignal | undefined,
  persistAbandonedPartial?: (claim: WorkerTurnPartialIdentity) => Promise<void>,
) {
  const { placements } = options;
  const nodeLoss = error instanceof WorkerNodeLostError ? error : undefined;
  let partialWritten = false;
  try {
    if (persistAbandonedPartial && placements.validateTurnClaim(claim)) {
      await persistAbandonedPartial({ ...claim, missingToolResultText: nodeLoss?.message });
      partialWritten = true;
    }
  } catch (persistenceError) {
    logWarn(
      `Cloud worker partial reply could not be saved: ${boundedWorkerError(persistenceError)}`,
    );
  }
  const pendingWorkspaceResult = await findPendingWorkerWorkspaceResult(placements, claim);
  if (pendingWorkspaceResult) {
    if (claim.owner.kind === "local") {
      // Record terminal reconciliation before teardown releases the claim.
      await placements.failWorkspaceResultAndReleaseTurn(pendingWorkspaceResult, error);
    } else {
      // Recovery owns the live claim and its durably fenced file results.
      await placements.handoffWorkspaceResultRecovery(claim);
    }
    if (!nodeLoss || !partialWritten) {
      await options.reconcileActivePlacement(placement.environmentId);
      throw error;
    }
  }
  if (nodeLoss && partialWritten) {
    try {
      if (!pendingWorkspaceResult) {
        assertCurrent();
        await options.environments.stopTunnel(placement.environmentId, placement.activeOwnerEpoch);
        await placements.closeWorkerTurnToolState(claim);
        await placements.retainInterruptedTurnWorkspace(claim, assertCurrent);
      }
      const signal = AbortSignal.any([
        AbortSignal.timeout(WORKER_ADMISSION_DEADLINE_MS),
        ...(abortSignal ? [abortSignal] : []),
      ]);
      await options.waitForAdmissionNode({ placement, signal, assertCurrent });
      await options.reconcileActivePlacement(placement.environmentId);
      const current = await placements.getAsync(placement.sessionId);
      assertCurrent();
      nodeLoss.canContinue =
        matchesWorkerPlacementTarget(current, placement) && current?.turnClaim === null;
    } catch (recoveryError) {
      nodeLoss.cause ??= recoveryError;
    }
    if (nodeLoss.canContinue || pendingWorkspaceResult) {
      throw error;
    }
  }
}

export async function failHandedOffTurn(params: {
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  placement: ActiveWorkerPlacement;
  turnClaim: WorkerSessionTurnClaim;
  error: unknown;
  terminal?: {
    observedAtMs: number;
    registerRecovery(recover: (assertCurrent?: () => void) => Promise<string | undefined>): void;
  };
}): Promise<void> {
  const failures = [boundedWorkerError(params.error)];
  let drained: WorkerSessionPlacementRecord;
  try {
    drained = await params.placements.startDrain({
      sessionId: params.placement.sessionId,
      environmentId: params.placement.environmentId,
      ownerEpoch: params.placement.activeOwnerEpoch,
      expectedGeneration: params.placement.generation,
      expectedTurnClaim: params.turnClaim,
    });
  } catch (error) {
    if (error instanceof AcceptedWorkspacePublicationIndeterminateError) {
      throw error;
    }
    const current = await params.placements.getAsync(params.placement.sessionId);
    const exactDrainOwner =
      current?.state === "draining" &&
      current.generation === params.placement.generation + 1 &&
      current.environmentId === params.placement.environmentId &&
      current.activeOwnerEpoch === params.placement.activeOwnerEpoch &&
      params.placements.validateTurnClaim(params.turnClaim);
    if (exactDrainOwner) {
      // Another lifecycle owner already closed admission for this exact turn.
      // Release its claim without stealing that owner's reconciliation or teardown.
      await releaseClaimIfOwned(params.placements, params.turnClaim);
    }
    // A different drain owner may belong to a replacement placement. Never
    // tear down an environment after losing the exact source-generation CAS.
    return;
  }
  if (drained.state !== "draining") {
    return;
  }
  const draining = drained;
  await releaseClaimIfOwned(params.placements, params.turnClaim);
  const isCurrentDrain = () => {
    const current = params.placements.get(draining.sessionId);
    return (
      current?.state === "draining" &&
      current.generation === draining.generation &&
      current.environmentId === draining.environmentId &&
      current.activeOwnerEpoch === draining.activeOwnerEpoch &&
      current.turnClaim === null
    );
  };
  // Cleanup and diagnostic recovery join the same write, including an unknown outcome.
  let recordingFailure: Promise<string | undefined> | undefined;
  const recordFailure = (assertCurrent?: () => void): Promise<string | undefined> => {
    if (recordingFailure) {
      return recordingFailure;
    }
    const operation = recordFailureOnce(assertCurrent);
    recordingFailure = operation;
    void operation.then(
      () => {
        recordingFailure = undefined;
      },
      (error: unknown) => {
        if (!(error instanceof AcceptedWorkspacePublicationIndeterminateError)) {
          recordingFailure = undefined;
        }
      },
    );
    return operation;
  };
  const recordFailureOnce = async (assertCurrent?: () => void): Promise<string | undefined> => {
    if (!isCurrentDrain()) {
      return undefined;
    }
    try {
      const reconciling = await params.placements.startReconcile(
        {
          sessionId: draining.sessionId,
          environmentId: draining.environmentId,
          ownerEpoch: draining.activeOwnerEpoch,
          expectedGeneration: draining.generation,
        },
        assertCurrent,
      );
      const recoveryError = failures.join("; ");
      const failed = await params.placements.fail(
        {
          sessionId: reconciling.sessionId,
          expectedGeneration: reconciling.generation,
          recoveryError,
        },
        assertCurrent,
      );
      reportPlacementTransition(undefined, failed);
      return recoveryError;
    } catch (error) {
      if (error instanceof AcceptedWorkspacePublicationIndeterminateError) {
        throw error;
      }
      // Leave the durable draining or reconciling row for startup reconciliation.
      return undefined;
    }
  };
  const terminalRecovery = params.terminal ? createDeferredCore() : undefined;
  if (params.terminal && terminalRecovery) {
    const observedAtMs = params.terminal.observedAtMs;
    params.terminal.registerRecovery(async (assertCurrent) => {
      if (Date.now() - observedAtMs < TERMINAL_WORKER_CLEANUP_GRACE_MS) {
        return undefined;
      }
      const recorded = await recordFailure(assertCurrent);
      if (recorded !== undefined) {
        terminalRecovery.resolve();
      }
      return recorded;
    });
  }
  const waitForCleanup = (operation: Promise<unknown>) =>
    terminalRecovery ? Promise.race([operation, terminalRecovery.promise]) : operation;
  for (const [label, cleanup] of [
    [
      "tunnel stop",
      () => params.environments.stopTunnel(draining.environmentId, draining.activeOwnerEpoch),
    ],
    ["environment destroy", () => params.environments.destroy(draining.environmentId)],
  ] as const) {
    // Recovery or replacement may have closed this drain while cleanup awaited.
    if (!isCurrentDrain()) {
      await recordingFailure;
      return;
    }
    try {
      await waitForCleanup(cleanup());
    } catch (error) {
      failures.push(`${label}: ${boundedWorkerError(error)}`);
    }
  }
  await recordFailure();
}
