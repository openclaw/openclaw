import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { placementAuthorityOwnerFor } from "./placement-authority-owner.js";
import { preparePlacementProjectionPublication } from "./placement-read-publication.js";
import {
  isCurrentPlacementTurnClaim,
  normalizeIdentity,
  required,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
  type WorkerTurnClaimInput,
} from "./placement-record.js";
import {
  projectLocalPlacementTurnClaim,
  stagePlacementTurnClaimWorkerPublication,
} from "./placement-turn-authority.js";
import { prepareWorkerTurnClaimClosed } from "./placement-turn-claim-events.js";
import { ActiveTurnClaimError } from "./placement-turn-claims.js";
import { SessionWorkspaceReservationBusyError } from "./placement-workspace-reservation.kernel.js";

export function createLocalPlacementTurnOps(
  runtime: { path: string; now?: () => number },
  read: (sessionId: string) => Promise<WorkerSessionPlacementRecord | undefined>,
) {
  const context = captureOpenClawStateWorkerContext({ path: runtime.path });
  const owner = placementAuthorityOwnerFor(context.admission.identity);
  const now = runtime.now ?? Date.now;
  const publish = (placement: WorkerSessionPlacementRecord) => {
    const projection = projectLocalPlacementTurnClaim(context.admission.identity, placement);
    const notification = projection
      ? preparePlacementProjectionPublication(context.admission.identity, projection)
      : undefined;
    stagePlacementTurnClaimWorkerPublication(
      context.admission.identity,
      placement,
      undefined,
      placement.state,
      placement,
      projection ? { projection, conflictSessionIds: new Set() } : undefined,
      undefined,
      true,
    ).commit();
    const change = { agentId: placement.agentId, sessionKey: placement.sessionKey };
    try {
      notification?.publish(change);
      sessionChanges.emit(change);
    } finally {
      notification?.release();
    }
  };
  return {
    async claimTurn(
      input: WorkerTurnClaimInput,
      assertCurrent?: () => void,
    ): Promise<WorkerSessionTurnClaim> {
      const identity = normalizeIdentity(input);
      const claimId = required(input.claimId, "turn claim id");
      const runId = required(input.runId, "turn claim run id");
      if (!owner.placements.has(identity.sessionId)) {
        await read(identity.sessionId);
      }
      context.admission.assertCurrent();
      assertCurrent?.();
      if (owner.localAdmissionReservations.has(identity.sessionId)) {
        throw new SessionWorkspaceReservationBusyError("The session workspace is busy.");
      }
      const current = owner.placements.get(identity.sessionId)?.placement;
      if (
        current &&
        (current.agentId !== identity.agentId || current.sessionKey !== identity.sessionKey)
      ) {
        throw new Error(`Worker session placement identity changed for ${identity.sessionId}`);
      }
      if (
        current?.turnClaim &&
        !(
          current.state === "local" &&
          current.turnClaim.claimId === claimId &&
          current.turnClaim.runId === runId &&
          current.turnClaim.generation === current.generation
        )
      ) {
        throw new ActiveTurnClaimError(identity.sessionId);
      }
      if (current && current.state !== "local") {
        throw new Error(
          `Local turn rejected for session ${identity.sessionId} in placement ${current.state}`,
        );
      }
      const updatedAtMs = now();
      const placement: WorkerSessionPlacementRecord = {
        ...(current ?? {
          ...identity,
          state: "local",
          executionMode: "worker-turn",
          generation: 0,
          environmentId: null,
          activeOwnerEpoch: null,
          workspaceBaseManifestRef: null,
          remoteWorkspaceDir: null,
          workerBundleHash: null,
          lastTranscriptAckCursor: null,
          lastLiveEventAckCursor: null,
          recoveryError: null,
          terminalReason: null,
          terminalAtMs: null,
          createdAtMs: updatedAtMs,
          stateChangedAtMs: updatedAtMs,
        }),
        updatedAtMs,
        turnClaim: {
          owner: "local",
          ownerEpoch: null,
          claimId,
          runId,
          generation: current?.generation ?? 0,
        },
      };
      owner.localClaimSessions.add(identity.sessionId);
      publish(placement);
      return {
        sessionId: identity.sessionId,
        claimId,
        runId,
        owner: { kind: "local" as const },
        placementGeneration: placement.generation,
      };
    },
    async releaseTurn(claim: WorkerSessionTurnClaim, assertCurrent?: () => void) {
      const pending = owner.localMutationSettlements.get(claim.sessionId);
      if (pending?.size) {
        await Promise.all(pending);
      }
      context.admission.assertCurrent();
      assertCurrent?.();
      const current = owner.placements.get(claim.sessionId)?.placement;
      if (
        !owner.localClaimSessions.has(claim.sessionId) ||
        !current ||
        !isCurrentPlacementTurnClaim(current, claim)
      ) {
        return undefined;
      }
      const close = prepareWorkerTurnClaimClosed(runtime.path, claim);
      const placement = { ...current, turnClaim: null, updatedAtMs: now() };
      publish(placement);
      close();
      emitSessionLifecycleEvent({
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        reason: "placement",
        scope: "runtime",
      });
      return placement;
    },
  };
}
