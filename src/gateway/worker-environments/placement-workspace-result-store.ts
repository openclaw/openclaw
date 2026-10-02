import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import {
  preparePlacementWorkspaceResultAuthority,
  readPlacementWorkspaceResultAuthority,
} from "./placement-turn-authority.js";

export function createPlacementWorkspaceResultReader(
  runtime: { path: string; instanceId: string },
  read: (ids: readonly string[]) => Promise<WorkerSessionPlacementProjection>,
) {
  const context = captureOpenClawStateWorkerContext({ path: runtime.path });
  const current = (claim: WorkerSessionTurnClaim) => {
    context.admission.assertCurrent();
    return readPlacementWorkspaceResultAuthority(context.admission.identity, claim);
  };
  return {
    workspaceResultInstanceId: () => runtime.instanceId,
    async prepareWorkspaceResultClaim(claim: WorkerSessionTurnClaim) {
      context.admission.assertCurrent();
      await preparePlacementWorkspaceResultAuthority(runtime.path, claim, read);
      context.admission.assertCurrent();
    },
    validateWorkspaceResultClaim: (claim: WorkerSessionTurnClaim) => Boolean(current(claim)),
    preparedWorkspaceResult: (claim: WorkerSessionTurnClaim) => current(claim)?.pendingResult,
    preparedWorkspaceResultPlacement: (claim: WorkerSessionTurnClaim) => current(claim)?.placement,
    async listPendingWorkspaceResults(sessionId?: string) {
      context.admission.assertCurrent();
      const reply = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath },
        { type: "workers.placementPendingResults", sessionId },
        { current: true },
      );
      context.admission.assertCurrent();
      if (!reply?.ok || reply.type !== "workers.placementPendingResults") {
        throw new Error("Worker workspace results are unavailable");
      }
      return reply.pendingResults;
    },
  };
}
