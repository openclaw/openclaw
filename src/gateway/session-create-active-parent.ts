import { isSessionControllerWorkActive } from "../sessions/session-controller.lifecycle.js";

/**
 * Ordinary parallel New (`succeedsParent: false`) inherits an active parent.
 * It must not refuse, and it must not run parent reset hooks, because those
 * hooks belong to a successor reset. Forks and worktrees keep the active-parent refusal.
 */
export function resolveActiveParentSessionCreate(
  params: {
    emitCommandHooks?: boolean;
    fork?: boolean;
    worktree?: boolean;
    succeedsParent?: boolean;
    forkFrom?: "last-completed";
    activeParentFork?: unknown;
  },
  parent: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
    agentId: string;
  },
): { blocked: boolean; emitParentResetHooks: boolean } {
  const emitCommandHooks = params.emitCommandHooks === true;
  const fork = params.fork === true;
  const parallelChild = params.succeedsParent === false && !fork && params.worktree !== true;
  const parentHasActiveWork =
    (emitCommandHooks || fork) &&
    isSessionControllerWorkActive(
      parent.storePath,
      [parent.sessionKey, parent.sessionId],
      parent.agentId,
    );
  const leaveActiveParentRunning = parentHasActiveWork && parallelChild;
  return {
    blocked:
      parentHasActiveWork &&
      !leaveActiveParentRunning &&
      (emitCommandHooks ||
        (params.forkFrom !== "last-completed" && params.activeParentFork === undefined)),
    emitParentResetHooks: emitCommandHooks && !leaveActiveParentRunning,
  };
}
