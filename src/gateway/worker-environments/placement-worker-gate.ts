import {
  projectPlacementTurnClaim,
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
    assertCurrent?: () => void;
  }): Promise<void>;
  prepareWorkspaceResultOwnerRevocation(
    binding: WorkerPlacementBinding,
    error: Error,
    assertCurrent?: () => void,
  ): Promise<void>;
  registerTurnClaimClosedHandler(handler: (claim: WorkerSessionTurnClaim) => void): () => void;
};

function claimForOwnerRevocation(
  record: WorkerSessionPlacementRecord | undefined,
  binding: WorkerPlacementBinding,
): WorkerSessionTurnClaim | undefined {
  if (
    (record?.state !== "active" && record?.state !== "draining") ||
    record.environmentId !== binding.environmentId ||
    record.activeOwnerEpoch !== binding.ownerEpoch
  ) {
    return undefined;
  }
  return projectPlacementTurnClaim(record);
}

export function createWorkerSessionPlacementGate(
  store: WorkerSessionPlacementStore,
  options: { recoveryPlacements?: readonly WorkerSessionPlacementRecord[] } = {},
): WorkerSessionPlacementGate {
  const recoveryOnlyClaims = new Set(
    (options.recoveryPlacements ?? []).flatMap((record) => {
      const claim = projectWorkerSessionTurnClaim(record);
      return claim ? [serializeWorkerSessionTurnClaim(claim)] : [];
    }),
  );
  const validateWorkerTurn = (claim: WorkerSessionTurnClaim) =>
    !recoveryOnlyClaims.has(serializeWorkerSessionTurnClaim(claim)) &&
    // Credential issuance precedes owner binding; attached turns already hold live authority.
    (getWorkerTurnExecutionIdentityCapability(store, claim) !== undefined ||
      store.validateTurnClaim(claim));

  const fenceWorkerTurnForRecovery = (claim: WorkerSessionTurnClaim) => {
    if (claim.owner.kind === "worker") {
      recoveryOnlyClaims.add(serializeWorkerSessionTurnClaim(claim));
    }
  };

  return {
    fenceWorkerTurnForRecovery,
    async prepareWorkerRuntimeRefresh(binding) {
      let prepared = await store.prepareRuntimeRefresh(binding.sessionId);
      const assertCurrent = () => prepared.assertCurrent();
      const release = () => prepared.release();
      const readRefreshOwner = () => {
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
        assertCurrent();
        return { placement, pendingResult, reclaimResult, claim };
      };
      try {
        let owner = readRefreshOwner();
        if (
          !owner.reclaimResult &&
          owner.claim &&
          owner.pendingResult?.gatewayInstanceId === store.workspaceResultInstanceId() &&
          owner.pendingResult.recoveryRequestedAtMs === null &&
          isCurrentWorkerWorkspacePendingResultOwner(owner.placement, owner.pendingResult)
        ) {
          // The writer checks the claim and generation at the handoff effect.
          prepared.release();
          await store.handoffRuntimeRefreshResult({
            claim: owner.claim,
            expectedGeneration: owner.placement.generation,
            gatewayInstanceId: store.workspaceResultInstanceId(),
          });
          prepared = await store.prepareRuntimeRefresh(binding.sessionId);
          owner = readRefreshOwner();
        }
        if (owner.reclaimResult && owner.claim) {
          fenceWorkerTurnForRecovery(owner.claim);
        }
        return {
          generation: owner.placement.generation,
          ...(owner.reclaimResult ? { reclaimResult: owner.reclaimResult } : {}),
          assertCurrent,
          release,
        };
      } catch (error) {
        release();
        throw error;
      }
    },
    readWorkerTurnClaim: (binding) => store.readWorkerTurnClaim(binding),
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

    async updateAckCursors(input) {
      const assertCurrent = () => {
        if (recoveryOnlyClaims.has(serializeWorkerSessionTurnClaim(input.claim))) {
          throw new Error(`Cannot ACK stale worker turn for session ${input.claim.sessionId}`);
        }
        input.assertCurrent?.();
      };
      await store.updateAckCursors(
        {
          claim: input.claim,
          ...(input.transcriptSeq === undefined ? {} : { transcript: input.transcriptSeq }),
          ...(input.liveSeq === undefined ? {} : { liveEvent: input.liveSeq }),
        },
        assertCurrent,
      );
    },

    async prepareWorkspaceResultOwnerRevocation(binding, error, assertCurrent): Promise<void> {
      const claim = claimForOwnerRevocation(await store.getAsync(binding.sessionId), binding);
      if (!claim) {
        return;
      }
      const pending = await findPendingWorkerWorkspaceResult(store, claim);
      assertCurrent?.();
      if (!pending || pending.gatewayInstanceId !== store.workspaceResultInstanceId()) {
        return;
      }
      if (
        claim.owner.kind === "local" &&
        pending.stagedResultRef === null &&
        pending.workspaceAcceptedAtMs === null
      ) {
        await store.failWorkspaceResultAndReleaseTurn(pending, error, assertCurrent);
        return;
      }
      await store.handoffWorkspaceResultRecovery(claim, assertCurrent);
    },

    registerTurnClaimClosedHandler: (handler) => store.registerTurnClaimClosedHandler(handler),
  };
}
