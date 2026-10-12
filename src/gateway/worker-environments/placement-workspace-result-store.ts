import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import { required, type WorkerSessionTurnClaim } from "./placement-record.js";
import {
  preparePlacementWorkspaceResultAuthority,
  readPlacementWorkspaceResultAuthority,
} from "./placement-turn-authority.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";

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
    /** @deprecated Await listPendingWorkspaceResultsAsync; retained for released plugin contexts. */
    listPendingWorkspaceResults(sessionId?: string): WorkerWorkspacePendingResult[] {
      void sessionId;
      warnPluginSdkDeprecation({
        family: "worker-placement-sync-readers",
        method: "listPendingWorkspaceResults",
        replacement: "listPendingWorkspaceResultsAsync",
        compatibility: "Synchronous placement inventory reads now fail with migration guidance.",
      });
      throw new Error(
        "Await listPendingWorkspaceResultsAsync; synchronous placement inventory reads are no longer supported.",
      );
    },
    /** @deprecated Await getWorkspaceResultReconcilingSessionIdsAsync. */
    getWorkspaceResultReconcilingSessionIds(sessionIds: readonly string[]): ReadonlySet<string> {
      void sessionIds;
      warnPluginSdkDeprecation({
        family: "worker-placement-sync-readers",
        method: "getWorkspaceResultReconcilingSessionIds",
        replacement: "getWorkspaceResultReconcilingSessionIdsAsync",
        compatibility: "Synchronous placement inventory reads now fail with migration guidance.",
      });
      throw new Error(
        "Await getWorkspaceResultReconcilingSessionIdsAsync; synchronous placement inventory reads are no longer supported.",
      );
    },
    async getWorkspaceResultReconcilingSessionIdsAsync(
      sessionIds: readonly string[],
    ): Promise<ReadonlySet<string>> {
      context.admission.assertCurrent();
      const ids = [...new Set(sessionIds.map((sessionId) => required(sessionId, "session id")))];
      const projection = await read(ids);
      context.admission.assertCurrent();
      return projection.workspaceResultReconcilingSessionIds;
    },
    async listPendingWorkspaceResultsAsync(sessionId?: string) {
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
