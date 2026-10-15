import { getRuntimeConfig } from "../../config/config.js";
import {
  assertRequiredWorkerMove,
  RequiredWorkerProfileError,
} from "../../config/required-worker-profile.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.types.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { PlacementTurnClaimCurrentCheck } from "./placement-turn-claims.types.js";

type PlacementTeardownStore = Pick<
  WorkerSessionPlacementStore,
  | "completePlacementMoveSourceToLocal"
  | "completeWorkspaceResultAndReleaseTurn"
  | "startReconcile"
  | "transition"
>;

export async function completeRecoveredWorkspaceTeardown(params: {
  placements: PlacementTeardownStore & Pick<WorkerSessionPlacementStore, "getPlacementMoveAsync">;
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>;
  turnClaim: WorkerSessionTurnClaim;
  destination?: "reclaimed";
  currentCheck?: PlacementTurnClaimCurrentCheck;
}) {
  const move = await params.placements.getPlacementMoveAsync(params.placement.sessionId);
  return completeWorkerWorkspaceTeardown({
    placements: params.placements,
    turnClaim: params.turnClaim,
    environmentId: params.placement.environmentId,
    ownerEpoch: params.placement.activeOwnerEpoch,
    move: params.destination === "reclaimed" ? undefined : move,
    currentCheck: params.currentCheck,
  });
}

/** Close the workspace-result fence, then advance the exact drained owner into reconciliation. */
export async function completeWorkerWorkspaceTeardown(params: {
  placements: PlacementTeardownStore;
  turnClaim: WorkerSessionTurnClaim;
  environmentId: string;
  ownerEpoch: number;
  move?: Pick<WorkerPlacementMoveIntent, "operationId" | "target">;
  currentCheck?: PlacementTurnClaimCurrentCheck;
}): Promise<Extract<WorkerSessionPlacementRecord, { state: "local" | "reclaimed" }>> {
  const drained = await params.placements.completeWorkspaceResultAndReleaseTurn(
    params.turnClaim,
    undefined,
    params.currentCheck,
  );
  if (
    drained.state !== "draining" ||
    drained.environmentId !== params.environmentId ||
    drained.activeOwnerEpoch !== params.ownerEpoch
  ) {
    throw new Error(`Session ${params.turnClaim.sessionId} lost its drained placement owner`);
  }
  const reconciling = await params.placements.startReconcile({
    sessionId: drained.sessionId,
    environmentId: params.environmentId,
    ownerEpoch: params.ownerEpoch,
    expectedGeneration: drained.generation,
  });
  if (reconciling.state !== "reconciling") {
    throw new Error(`Session ${params.turnClaim.sessionId} did not enter reconciliation`);
  }
  const move = params.move;
  if (move) {
    try {
      const completed = await params.placements.completePlacementMoveSourceToLocal(
        {
          operationId: move.operationId,
          sessionId: reconciling.sessionId,
          expectedGeneration: reconciling.generation,
        },
        { assertCurrent: () => assertRequiredWorkerMove(getRuntimeConfig(), move.target) },
      );
      if (completed.state !== "local") {
        throw new Error(`Session ${params.turnClaim.sessionId} move did not finish local`);
      }
      return completed;
    } catch (error) {
      if (!(error instanceof RequiredWorkerProfileError)) {
        throw error;
      }
      // Destruction is committed, but destination admission was refused and rolled back.
      // The existing reclaimed transition settles only this source and retires its Move.
    }
  }
  const completed = await params.placements.transition({
    sessionId: reconciling.sessionId,
    from: "reconciling",
    to: "reclaimed",
    expectedGeneration: reconciling.generation,
  });
  if (completed.state !== "reclaimed") {
    throw new Error(`Session ${params.turnClaim.sessionId} teardown did not finish reclaimed`);
  }
  return completed;
}
