import { getRuntimeConfig } from "../../config/config.js";
import { assertRequiredWorkerMove } from "../../config/required-worker-profile.js";
import { assertRepositoryWorkspaceDiskIdentity } from "../../state/session-repository-workspaces.authority.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { WorkerDispatchPlacement } from "./placement-dispatch-failure.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";
import { isExactAttachedEnvironment } from "./placement-target.js";
import { completeWorkerWorkspaceTeardown } from "./placement-teardown.js";
import { isRepositoryDiskGatewayMoveResult } from "./placement-workspace-result-owner.js";
import { isWorkerRetainedWindowOpen } from "./retained-work-window.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerWorkspaceQuiescence } from "./tunnel-contract.js";

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

/** Caller holds the session/result fence and existing workspace command queue. */
export async function settleRepositoryDiskGatewayMove(params: {
  deps: Pick<PlacementRecoveryDeps, "placements" | "environments" | "prepareGatewayMove">;
  placement: WorkerOwnedPendingPlacement;
  turnClaim: WorkerSessionTurnClaim;
  workspace: WorkerSessionWorkspace;
  assertCurrent: () => void;
  recovering?: boolean;
}) {
  const { deps, placement, turnClaim } = params;
  const { placements, environments } = deps;
  const pending = placements.preparedWorkspaceResult(turnClaim);
  const move = await placements.getPlacementMoveAsync(placement.sessionId);
  if (
    !pending?.repositoryDiskAuthority ||
    !pending.repositoryWorkspaceId ||
    !move ||
    !isRepositoryDiskGatewayMoveResult(placement, pending, move)
  ) {
    throw new Error("Repository disk transfer requires its exact Gateway move result");
  }
  const prepared = await getSessionRepositoryWorkspaceStore().prepare(
    pending.repositoryWorkspaceId,
  );
  const assertCurrent = () => {
    params.assertCurrent();
    assertRequiredWorkerMove(getRuntimeConfig(), move.target);
    const current = placements.preparedWorkspaceResultPlacement(turnClaim);
    const environment = environments.get(placement.environmentId);
    assertRepositoryWorkspaceDiskIdentity(pending.repositoryDiskAuthority!, environment);
    if (
      current?.state !== "draining" ||
      current.generation !== placement.generation ||
      current.environmentId !== placement.environmentId ||
      current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
      !placements.validateWorkspaceResultClaim(turnClaim) ||
      !prepared.current() ||
      (environment?.destroyRequestedAtMs === null &&
        !isExactAttachedEnvironment(environment, current))
    ) {
      throw new Error("Repository disk move lost its source custody");
    }
  };
  assertCurrent();
  let quiescence: WorkerWorkspaceQuiescence | undefined;
  try {
    if (prepared.current()?.diskAuthority && params.workspace.kind === "repository") {
      if (!isExactAttachedEnvironment(environments.get(placement.environmentId), placement)) {
        throw new Error("The original repository disk must be attached before Move export");
      }
      if (params.recovering) {
        await environments.stopTunnel(placement.environmentId, placement.activeOwnerEpoch);
        assertCurrent();
      }
      if (!isWorkerRetainedWindowOpen(environments.get(placement.environmentId))) {
        await environments.ensureRetainedRunning({
          environmentId: placement.environmentId,
          expectedOwnerEpoch: placement.activeOwnerEpoch,
          assertCurrent,
        });
        assertCurrent();
      }
      const tunnel = await environments.startTunnel({
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
        authorize: assertCurrent,
      });
      assertCurrent();
      quiescence = await tunnel.quiesceWorkspace(placement.remoteWorkspaceDir, assertCurrent);
      assertCurrent();
    }
    if (!deps.prepareGatewayMove) {
      throw new Error("Repository workspace materialization is unavailable");
    }
    await deps.prepareGatewayMove({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      assertCurrent,
      quiescence,
      diskResult: turnClaim,
    });
    assertCurrent();
    const retired = prepared.current();
    const result = placements.preparedWorkspaceResult(turnClaim);
    if (
      retired?.diskAuthority ||
      !result?.stagedResultRef ||
      retired?.checkpointRef !== result.stagedResultRef
    ) {
      throw new Error("Repository disk custody has not been handed to the Gateway");
    }
    await placements.acceptWorkspaceResult(turnClaim, assertCurrent);
    assertCurrent();
    if (turnClaim.owner.kind === "worker") {
      await placements.closeWorkerTurnToolState(turnClaim);
    }
    assertCurrent();
    // Custody retirement is committed. The original environment owner now settles
    // exact-receipt cleanup; a lost reply retains this result for the next sweep.
    await environments.reclaim(placement.environmentId);
    return await completeWorkerWorkspaceTeardown({
      placements,
      turnClaim,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      move,
    });
  } finally {
    if (
      quiescence &&
      isExactAttachedEnvironment(environments.get(placement.environmentId), placement)
    ) {
      await quiescence.resume();
    }
  }
}
