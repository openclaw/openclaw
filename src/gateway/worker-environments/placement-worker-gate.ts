import {
  placementTurnOwner,
  projectWorkerSessionTurnClaim,
  serializeWorkerSessionTurnClaim,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  getWorkerTurnExecutionIdentityCapability,
  type WorkerTurnExecutionIdentityCapability,
} from "./placement-turn-claim-events.js";
import {
  findPendingWorkerWorkspaceResult,
  isCurrentWorkerWorkspacePendingResultOwner,
} from "./placement-workspace-result.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";

type WorkerPlacementBinding = Readonly<{
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
}>;

export type WorkerSessionPlacementGate = {
  fenceWorkerTurnForRecovery: (claim: WorkerSessionTurnClaim) => void;
  /** Refresh runtime bytes without changing the retained workspace's owner epoch. */
  prepareWorkerRuntimeRefresh(binding: WorkerPlacementBinding): Promise<{
    generation: number;
    reclaimResult?: WorkerWorkspacePendingResult;
    assertCurrent: () => void;
    release: () => void;
  }>;
  /** Credential verification only; this does not grant operational worker authority. */
  readWorkerTurnClaim(binding: WorkerPlacementBinding): WorkerSessionTurnClaim | undefined;
  getExecutionIdentityCapability?(
    claim: WorkerSessionTurnClaim,
  ): WorkerTurnExecutionIdentityCapability | undefined;
  readWorkerTurnLiveAckCursor(claim: WorkerSessionTurnClaim): number;
  validateWorkerTurn(claim: WorkerSessionTurnClaim): boolean;
  isWorkerTurnToolAuthorized(claim: WorkerSessionTurnClaim, toolName: string): boolean;
  updateAckCursors(input: {
    claim: WorkerSessionTurnClaim;
    transcriptSeq?: number;
    liveSeq?: number;
  }): void;
  prepareWorkspaceResultOwnerRevocation(binding: WorkerPlacementBinding, error: Error): void;
  registerTurnClaimClosedHandler(handler: (claim: WorkerSessionTurnClaim) => void): () => void;
};

function claimForBinding(
  record: WorkerSessionPlacementRecord | undefined,
  binding: WorkerPlacementBinding,
): WorkerSessionTurnClaim | undefined {
  const claim = record ? projectWorkerSessionTurnClaim(record) : undefined;
  return claim?.sessionId === binding.sessionId &&
    claim.owner.environmentId === binding.environmentId &&
    claim.owner.ownerEpoch === binding.ownerEpoch
    ? claim
    : undefined;
}

function claimForOwnerRevocation(
  record: WorkerSessionPlacementRecord | undefined,
  binding: WorkerPlacementBinding,
): WorkerSessionTurnClaim | undefined {
  if (
    (record?.state !== "active" && record?.state !== "draining") ||
    record.environmentId !== binding.environmentId ||
    record.activeOwnerEpoch !== binding.ownerEpoch ||
    !record.turnClaim
  ) {
    return undefined;
  }
  return {
    sessionId: record.sessionId,
    claimId: record.turnClaim.claimId,
    runId: record.turnClaim.runId,
    placementGeneration: record.turnClaim.generation,
    owner: placementTurnOwner(record),
  };
}

export function createWorkerSessionPlacementGate(
  store: WorkerSessionPlacementStore,
  options: { rejectExistingWorkerClaims?: boolean } = {},
): WorkerSessionPlacementGate {
  const recoveryOnlyClaims = new Set(
    options.rejectExistingWorkerClaims
      ? store.list().flatMap((record) => {
          const claim = projectWorkerSessionTurnClaim(record);
          return claim ? [serializeWorkerSessionTurnClaim(claim)] : [];
        })
      : [],
  );
  const validateWorkerTurn = (claim: WorkerSessionTurnClaim) =>
    !recoveryOnlyClaims.has(serializeWorkerSessionTurnClaim(claim)) &&
    store.validateTurnClaim(claim);

  const readWorkerTurnClaim = (binding: WorkerPlacementBinding) => {
    const claim = claimForBinding(store.get(binding.sessionId), binding);
    return claim && store.validateTurnClaim(claim) ? claim : undefined;
  };

  const fenceWorkerTurnForRecovery = (claim: WorkerSessionTurnClaim) => {
    if (claim.owner.kind === "worker") {
      recoveryOnlyClaims.add(serializeWorkerSessionTurnClaim(claim));
    }
  };

  return {
    fenceWorkerTurnForRecovery,
    async prepareWorkerRuntimeRefresh(binding) {
      const prepared = await store.prepareRuntimeRefresh(binding.sessionId);
      try {
        const { placement, pendingResult } = prepared;
        const reclaimResult =
          placement?.state === "draining" &&
          pendingResult &&
          pendingResult.claimId === pendingResult.runId &&
          pendingResult.claimId.startsWith("reclaim-") &&
          (pendingResult.gatewayInstanceId !== store.workspaceResultInstanceId() ||
            pendingResult.recoveryRequestedAtMs !== null) &&
          isCurrentWorkerWorkspacePendingResultOwner(placement, pendingResult)
            ? pendingResult
            : undefined;
        if (
          (placement?.state !== "active" && !reclaimResult) ||
          !placement ||
          placement.environmentId !== binding.environmentId ||
          placement.activeOwnerEpoch !== binding.ownerEpoch ||
          prepared.move
        ) {
          throw new Error("Worker runtime refresh lost its placement recovery owner");
        }
        const claim = projectWorkerSessionTurnClaim(placement);
        if (
          !reclaimResult &&
          placement.turnClaim &&
          (!claim || !recoveryOnlyClaims.has(serializeWorkerSessionTurnClaim(claim)))
        ) {
          throw new Error("Worker runtime refresh is waiting for the current turn to finish");
        }
        prepared.assertCurrent();
        if (reclaimResult && claim) {
          fenceWorkerTurnForRecovery(claim);
        }
        return {
          generation: placement.generation,
          ...(reclaimResult ? { reclaimResult } : {}),
          assertCurrent: prepared.assertCurrent,
          release: prepared.release,
        };
      } catch (error) {
        prepared.release();
        throw error;
      }
    },
    readWorkerTurnClaim,
    getExecutionIdentityCapability: (claim) =>
      getWorkerTurnExecutionIdentityCapability(store, claim),
    validateWorkerTurn,

    readWorkerTurnLiveAckCursor(claim): number {
      if (!validateWorkerTurn(claim)) {
        throw new Error(`Cannot read ACK cursor for stale worker turn ${claim.sessionId}`);
      }
      const placement = store.get(claim.sessionId);
      if (!placement) {
        throw new Error(`Worker placement disappeared for session ${claim.sessionId}`);
      }
      return placement.lastLiveEventAckCursor ?? 0;
    },

    isWorkerTurnToolAuthorized(claim, toolName): boolean {
      return validateWorkerTurn(claim) && store.isWorkerTurnToolAuthorized(claim, toolName);
    },

    updateAckCursors(input): void {
      if (!validateWorkerTurn(input.claim)) {
        throw new Error(`Cannot ACK stale worker turn for session ${input.claim.sessionId}`);
      }
      store.updateAckCursors({
        claim: input.claim,
        ...(input.transcriptSeq === undefined ? {} : { transcript: input.transcriptSeq }),
        ...(input.liveSeq === undefined ? {} : { liveEvent: input.liveSeq }),
      });
    },

    prepareWorkspaceResultOwnerRevocation(binding, error): void {
      const claim = claimForOwnerRevocation(store.get(binding.sessionId), binding);
      if (!claim) {
        return;
      }
      const pending = findPendingWorkerWorkspaceResult(store, claim);
      if (!pending) {
        return;
      }
      if (pending.gatewayInstanceId !== store.workspaceResultInstanceId()) {
        return;
      }
      if (
        claim.owner.kind === "local" &&
        pending.stagedResultRef === null &&
        pending.workspaceAcceptedAtMs === null
      ) {
        store.failWorkspaceResultAndReleaseTurn(pending, error);
        return;
      }
      store.handoffWorkspaceResultRecovery(claim);
    },

    registerTurnClaimClosedHandler: (handler) => store.registerTurnClaimClosedHandler(handler),
  };
}
