import { worktreeRegistryPublication } from "../../agents/worktrees/registry-publication.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withGitProcessOperation } from "../../process/spawn-diagnostics.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../../sessions/session-row-changes.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import type {
  PlacementRecoveryDeps,
  WorkerPlacementRecoveryAdmission,
} from "./placement-recovery-contract.js";
import { WorkerPlacementWorkspaceUnavailableError } from "./placement-workspace-unavailable.js";
import {
  cleanupWorkerWorkspaceResultRef,
  deleteWorkerWorkspaceResultCleanupRefs,
} from "./workspace-result-staging.js";

type UnavailableTarget = WorkerPlacementWorkspaceUnavailableError["target"];

/** Shared by the retry queue and unresolved set; notification scans reuse the record. */
type PendingWorkspaceLookup = {
  placement: WorkerSessionPlacementIdentity;
  target: UnavailableTarget | undefined;
  /** Publications during resolution leave the item eligible for the next sweep. */
  dirty: boolean;
};

/** One startup pass of orphan-ref cleanup: workspace roots resolved once, completed roots remembered. */
export type PendingWorkspaceResultOrphanCleanup = {
  placements: PendingWorkspaceLookup[];
  initialDiscoveryPending: boolean;
  unresolved: Set<PendingWorkspaceLookup>;
  /** sessionId → workspace root, or null when the placement has no local root to clean. */
  rootsBySession: Map<string, string | null>;
  completedRoots: Set<string>;
};

export function subscribeWorkspaceResultOrphanChanges(
  getPass: () => PendingWorkspaceResultOrphanCleanup | undefined,
): () => void {
  const wake = (
    pass: PendingWorkspaceResultOrphanCleanup,
    matches: (target?: UnavailableTarget) => boolean,
  ) => {
    for (const lookup of pass.unresolved) {
      if (matches(lookup.target)) {
        lookup.dirty = true;
        if (lookup.target) {
          lookup.target = undefined;
          pass.placements.push(lookup);
        }
      }
    }
  };
  const stopSessions = sessionChanges.subscribeFacts((change) => {
    const pass = getPass();
    if (
      !pass?.unresolved.size ||
      (!sessionChangeScopeAffectsStoredRows(change) &&
        !("all" in change && change.scope === "config"))
    ) {
      return;
    }
    if (
      "sessionKey" in change &&
      (change.scope === "transcript" ||
        change.factsInvalidated === "category" ||
        (!change.factsInvalidated &&
          change.facts &&
          !["entry", "replacement", "removed"].includes(change.facts.kind)))
    ) {
      return;
    }
    const scope =
      "sessionKey" in change ? change : typeof change.scope === "object" ? change.scope : {};
    // A resolving item has not captured its physical store/canonical key yet.
    // Keyed publications carry the logical agent, which may share another agent's store.
    wake(
      pass,
      (target) =>
        !target ||
        ((!("sessionKey" in change) || change.sessionKey === target.sessionKey) &&
          ("sessionKey" in change || !scope.agentId || scope.agentId === target.agentId) &&
          (!scope.storePath || scope.storePath === target.storePath)),
    );
  });
  const stopWorktrees = worktreeRegistryPublication.subscribeFacts((change) => {
    const pass = getPass();
    // A bare settlement may be a rollback; committed/unknown facts precede it.
    if (!pass?.unresolved.size || (change.kind !== "committed" && change.kind !== "unknown")) {
      return;
    }
    wake(pass, (target) => {
      if (target && !target.worktreeId) {
        return false;
      }
      if (change.kind === "unknown") {
        return true;
      }
      for (const [key, fact] of change.receipt.facts) {
        if (fact.kind === "postimage" && "id" in fact.value) {
          if (
            !target ||
            fact.value.id === target.worktreeId ||
            (fact.value.owner_kind === "session" && fact.value.owner_id === target.sessionKey)
          ) {
            return true;
          }
        } else if (
          key.startsWith('["worktrees",') &&
          (!target || key === JSON.stringify(["worktrees", target.worktreeId]))
        ) {
          return true;
        }
      }
      return false;
    });
  });
  return () => {
    stopSessions();
    stopWorktrees();
  };
}

export async function cleanupPendingWorkspaceResultOrphans(
  deps: PlacementRecoveryDeps,
  admit: WorkerPlacementRecoveryAdmission,
  pass: PendingWorkspaceResultOrphanCleanup,
): Promise<boolean> {
  if (deps.isShuttingDown?.() || getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0) {
    return false;
  }
  const { placements } = deps;
  const { completedRoots, rootsBySession } = pass;
  // Discover the startup set once, then rotate failed lookups instead of rescanning
  // every unavailable workspace each minute. Snapshot the budget before requeueing.
  const attempts = pass.initialDiscoveryPending
    ? pass.placements.length
    : Math.min(pass.placements.length, 8);
  for (let index = 0; index < attempts; index++) {
    if (deps.isShuttingDown?.()) {
      return false;
    }
    const lookup = pass.placements.shift()!;
    const { placement } = lookup;
    lookup.dirty = false;
    try {
      const workspace = await deps.resolveWorkspace(placement);
      rootsBySession.set(placement.sessionId, workspace.kind === "local" ? workspace.path : null);
      pass.unresolved.delete(lookup);
    } catch (error) {
      if (error instanceof WorkerPlacementWorkspaceUnavailableError && !lookup.dirty) {
        lookup.target = error.target;
      } else {
        pass.placements.push(lookup);
      }
    }
  }
  pass.initialDiscoveryPending = false;
  let complete = pass.unresolved.size === 0;
  const workspaceSessions = new Map<string, string[]>();
  // Admission includes previously resolved siblings, even if only one root was found this sweep.
  for (const [sessionId, root] of rootsBySession) {
    if (root === null) {
      continue;
    }
    const sessionIds = workspaceSessions.get(root) ?? [];
    sessionIds.push(sessionId);
    workspaceSessions.set(root, sessionIds);
  }
  // The existing minute sweep owns continuation; orphan refs carry no live authority.
  // Keep serial session admission and bound cold-start work independently of history size.
  let remaining = 8;
  for (const [root, sessionIds] of workspaceSessions) {
    if (completedRoots.has(root)) {
      continue;
    }
    if (
      deps.isShuttingDown?.() ||
      remaining === 0 ||
      getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0
    ) {
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
          if (
            deps.isShuttingDown?.() ||
            getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0
          ) {
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
