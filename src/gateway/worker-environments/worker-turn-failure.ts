import { createDeferredCore } from "../../shared/deferred.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import { boundedWorkerError } from "./worker-error.js";
import { releaseClaimIfOwned } from "./worker-turn-admission.js";
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

export class WorkerTurnExecutionError extends Error {}

export class WorkerWorkspaceReconciliationError extends Error {
  override name = "WorkerWorkspaceReconciliationError";
}

// Journal-terminal launches get a short cleanup grace before failure is surfaced.
// This never limits a live launch or a turn still holding its claim.
const TERMINAL_WORKER_CLEANUP_GRACE_MS = 30_000;

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
    const current = params.placements.get(params.placement.sessionId);
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
      await params.placements.fail(
        {
          sessionId: reconciling.sessionId,
          expectedGeneration: reconciling.generation,
          recoveryError,
        },
        assertCurrent,
      );
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
  if (!isCurrentDrain()) {
    await recordingFailure;
    return;
  }
  try {
    await waitForCleanup(
      params.environments.stopTunnel(
        params.placement.environmentId,
        params.placement.activeOwnerEpoch,
      ),
    );
  } catch (error) {
    failures.push(`tunnel stop: ${boundedWorkerError(error)}`);
  }
  // Recovery may have recorded failure, or a replacement may own the session.
  // A late cleanup completion must never destroy that newer placement.
  if (!isCurrentDrain()) {
    await recordingFailure;
    return;
  }
  try {
    await waitForCleanup(params.environments.destroy(params.placement.environmentId));
  } catch (error) {
    failures.push(`environment destroy: ${boundedWorkerError(error)}`);
  }
  await recordFailure();
}
