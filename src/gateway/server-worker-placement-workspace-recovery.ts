import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerSessionWorkspace } from "./worker-environments/session-workspace.js";
import { recoverWorkerWorkspaceReconciliation } from "./worker-environments/workspace-reconcile.js";

const workerPlacementLog = createSubsystemLogger("gateway/worker-placement");

export async function recoverGatewayWorkerPlacementWorkspaces(params: {
  placements: WorkerSessionPlacementStore;
  resolveWorkspace: (identity: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<WorkerSessionWorkspace>;
}): Promise<void> {
  const orphanedJournals = await params.placements.pruneOrphanedWorkspaceReconciliations();
  for (const owner of orphanedJournals) {
    workerPlacementLog.warn(`discarded orphaned cloud workspace journal for ${owner.sessionId}`);
  }
  for (const owner of await params.placements.listWorkspaceReconciliationOwners()) {
    try {
      const placement = await params.placements.getWorkspaceReconciliationPlacement(owner);
      if (!placement) {
        throw new Error(`Cloud workspace journal has no matching owner: ${owner.sessionId}`);
      }
      const workspace = await params.resolveWorkspace({
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
      });
      if (workspace.kind !== "local") {
        throw new Error(
          "Repository checkpoints cannot own a local worktree reconciliation journal",
        );
      }
      const journal = await params.placements.loadWorkspaceReconciliation(owner);
      if (!journal) {
        continue;
      }
      // Recover before placement/environment reconciliation can reclaim the
      // owner; otherwise a crashed partial apply loses its final repair path.
      await recoverWorkerWorkspaceReconciliation({ root: workspace.path, journal });
      await params.placements.abortWorkspaceReconciliation(owner);
    } catch (error) {
      // A local edit can intentionally block rollback. Leave that journal
      // retryable for this session without withholding every cloud worker.
      workerPlacementLog.error(
        `cloud workspace recovery deferred for ${owner.sessionId}: ${formatErrorMessage(error)}`,
      );
    }
  }
}
