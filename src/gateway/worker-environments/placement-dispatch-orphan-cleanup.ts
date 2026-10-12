import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withGitProcessOperation } from "../../process/spawn-diagnostics.js";
import type {
  PlacementRecoveryDeps,
  WorkerPlacementRecoveryAdmission,
} from "./placement-recovery-contract.js";
import {
  cleanupWorkerWorkspaceResultRef,
  deleteWorkerWorkspaceResultCleanupRefs,
} from "./workspace-result-staging.js";

/** One startup pass of orphan-ref cleanup: workspace roots resolved once, completed roots remembered. */
export type PendingWorkspaceResultOrphanCleanup = {
  /** sessionId → workspace root, or null when the placement has no local root to clean. */
  rootsBySession: Map<string, string | null>;
  completedRoots: Set<string>;
};

export async function cleanupPendingWorkspaceResultOrphans(
  deps: PlacementRecoveryDeps,
  admit: WorkerPlacementRecoveryAdmission,
  pass: PendingWorkspaceResultOrphanCleanup,
): Promise<boolean> {
  if (getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0) {
    return false;
  }
  const { placements } = deps;
  const { completedRoots, rootsBySession } = pass;
  // A sweep is incomplete until every admitted placement has been resolved and cleaned.
  let complete = true;
  // Each sweep admits the current placements, but a placement's workspace root is resolved
  // once per pass; a failed resolution stays uncached and is retried on the next sweep.
  const workspaceSessions = new Map<string, string[]>();
  for (const placement of await placements.readChangeSnapshot()) {
    let root = rootsBySession.get(placement.sessionId);
    if (root === undefined) {
      try {
        const workspace = await deps.resolveWorkspace(placement);
        root = workspace.kind === "repository" ? null : workspace.path;
        rootsBySession.set(placement.sessionId, root);
      } catch {
        // Cleanup refs are independently retryable on the next sweep or after the next restart.
        // A resolution failure is an incomplete sweep: retain the pending pass so the caller
        // does not clear it, and the unresolved session is retried on the next sweep.
        complete = false;
        continue;
      }
    }
    if (root === null) {
      continue;
    }
    const sessionIds = workspaceSessions.get(root) ?? [];
    sessionIds.push(placement.sessionId);
    workspaceSessions.set(root, sessionIds);
  }
  // The existing minute sweep owns continuation; orphan refs carry no live authority.
  // Keep serial session admission and bound cold-start work independently of history size.
  let remaining = 8;
  for (const [root, sessionIds] of workspaceSessions) {
    if (completedRoots.has(root)) {
      continue;
    }
    if (remaining === 0 || getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0) {
      return false;
    }
    const idleAdmission = tryBeginGatewayRootWorkAdmission("idle-task");
    if (!idleAdmission) {
      return false;
    }
    try {
      let deferred = false;
      const admitted = await idleAdmission.run(() =>
        admit(sessionIds, async () => {
          if (getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0) {
            deferred = true;
            return;
          }
          remaining -= 1;
          await withGitProcessOperation("workspace.result-cleanup", () =>
            deleteWorkerWorkspaceResultCleanupRefs({
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
            }),
          );
          completedRoots.add(root);
        }),
      );
      complete = admitted && !deferred && complete;
    } catch {
      // Cleanup refs are independently retryable after the next restart.
      completedRoots.add(root);
    } finally {
      idleAdmission.release();
    }
  }
  return complete;
}
