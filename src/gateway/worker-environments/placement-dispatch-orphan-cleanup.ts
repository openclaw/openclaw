import type {
  PlacementRecoveryDeps,
  WorkerPlacementRecoveryAdmission,
} from "./placement-recovery-contract.js";
import {
  cleanupWorkerWorkspaceResultRef,
  deleteWorkerWorkspaceResultCleanupRefs,
} from "./workspace-result-staging.js";

export async function cleanupPendingWorkspaceResultOrphans(
  deps: PlacementRecoveryDeps,
  admit: WorkerPlacementRecoveryAdmission,
): Promise<boolean> {
  const { placements } = deps;
  const workspaceSessions = new Map<string, string[]>();
  for (const placement of await placements.readChangeSnapshot()) {
    try {
      const workspace = await deps.resolveWorkspace(placement);
      if (workspace.kind === "repository") {
        continue;
      }
      const root = workspace.path;
      const sessionIds = workspaceSessions.get(root) ?? [];
      sessionIds.push(placement.sessionId);
      workspaceSessions.set(root, sessionIds);
    } catch {
      // Cleanup refs are independently retryable after the next restart.
    }
  }
  let complete = true;
  for (const [root, sessionIds] of workspaceSessions) {
    try {
      const admitted = await admit(sessionIds, async () => {
        await deleteWorkerWorkspaceResultCleanupRefs({
          root,
          retainedRefs: async () => {
            const candidates = await placements.readRecoveryCandidates();
            const facts = await placements.readProjection(
              candidates.map(({ sessionId }) => sessionId),
              { current: true },
            );
            return new Set(
              [...facts.pendingResults.values()].flatMap((pending) =>
                pending.stagedResultRef
                  ? [cleanupWorkerWorkspaceResultRef(pending.stagedResultRef)]
                  : [],
              ),
            );
          },
        });
      });
      complete = admitted && complete;
    } catch {
      // Cleanup refs are independently retryable after the next restart.
    }
  }
  return complete;
}
