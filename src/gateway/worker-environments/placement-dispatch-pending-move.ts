import { getRuntimeConfig } from "../../config/config.js";
import { assertRequiredWorkerMove } from "../../config/required-worker-profile.js";
import type { WorkerDispatchPlacement } from "./placement-dispatch-failure.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";

type WorkerOwnedPendingPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "active" | "draining" }
>;

/** Carry the prepared Move's authority across the caller's final teardown await. */
export function createPendingGatewayMovePreparation(deps: PlacementRecoveryDeps) {
  const { placements } = deps;
  return async (
    placement: WorkerOwnedPendingPlacement,
    turnClaim: WorkerSessionTurnClaim,
    assertCurrent: () => void,
  ) => {
    const move = (
      await placements.readProjection([placement.sessionId], { current: true })
    ).moves.get(placement.sessionId);
    if (move?.target.kind !== "gateway") {
      return undefined;
    }
    const assertMoveCurrent = () => {
      assertCurrent();
      assertRequiredWorkerMove(getRuntimeConfig(), move.target);
      if (!placements.validateWorkspaceResultClaim(turnClaim)) {
        throw new Error("Recovered Gateway move lost its workspace result owner");
      }
    };
    assertMoveCurrent();
    await deps.prepareGatewayMove?.({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      assertCurrent: assertMoveCurrent,
    });
    assertMoveCurrent();
    return assertMoveCurrent;
  };
}
