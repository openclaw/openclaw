import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/work-start-error.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { captureAgentWorkspaceReadiness } from "../workspace-readiness.js";
import { worktreePathExists } from "./git.js";
import { captureWorktreeRegistryReadGuard, readRegistryWorktree } from "./registry-read.js";
import { retireMissingRegistryWorktree } from "./registry-retirement.js";
import { recordRegistryWorktreeActivity } from "./registry.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import type { ManagedWorktreeRecord } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

/** Registry-owned availability is shared by session projections and turn admission. */
export function sessionWorktreeAvailability(
  record: ManagedWorktreeRecord | null | undefined,
  sessionKey?: string,
) {
  if (!record && sessionKey && captureAgentWorkspaceReadiness(sessionKey)?.isReady?.() === false) {
    return undefined;
  }
  return record && record.removedAt === undefined
    ? { status: "ready" as const }
    : {
        status: "removed" as const,
        restore: record?.snapshotRef ? ("snapshot" as const) : ("fresh" as const),
      };
}

class SessionWorktreeUnavailableError extends SessionWorkStartInvalidatedError {
  constructor(id: string) {
    super(
      `This session's worktree was removed by cleanup or deletion. Use Restore in Settings > Worktrees (worktrees.restore), or start a new session. Worktree: ${id}.`,
    );
    log.warn("Session worktree unavailable", { worktreeId: id, reason: "restore-required" });
  }
}

/** Observe missing directories once at the lifecycle boundary, then publish the removal fact. */
export async function reconcileSessionWorktreeAvailability(
  record: ManagedWorktreeRecord | undefined,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
) {
  if (record && record.removedAt === undefined && !(await worktreePathExists(record.path))) {
    assertCurrent();
    return (await retireMissingRegistryWorktree(env, record, Date.now(), assertCurrent)).record;
  }
  return record;
}

/** Turns and passive Review refuse removed checkouts; only explicit restore provisions them. */
export async function resolveSessionWorktree(params: {
  binding: NonNullable<SessionEntry["worktree"]>;
  sessionKey: string;
  assertCurrent: () => void;
  turn?: boolean;
}) {
  const { binding, sessionKey } = params;
  const context = captureWorktreeRunEndContext(process.env);
  const accept = params.turn ? undefined : captureWorktreeRegistryReadGuard(context, "lifecycle");
  let worktree = await readRegistryWorktree(context, binding.id);
  const assertOwner = accept?.(worktree);
  const assertCurrent = assertOwner
    ? composeSessionSourceAssertion([params.assertCurrent], (assertSource) => {
        assertSource();
        assertOwner();
      })
    : params.assertCurrent;
  assertCurrent();
  if (!worktree && params.turn) {
    const readiness = captureAgentWorkspaceReadiness(sessionKey);
    if (readiness?.isReady?.() === false) {
      // The admitted creation owns this unpublished checkout and gates workspace effects.
      readiness.assertCurrent();
      return undefined;
    }
  }
  if (
    worktree &&
    (worktree.ownerKind !== "session" ||
      worktree.ownerId !== sessionKey ||
      worktree.repoRoot !== binding.repoRoot ||
      worktree.branch !== binding.branch)
  ) {
    throw new Error("Session worktree owner changed");
  }
  worktree = await reconcileSessionWorktreeAvailability(
    worktree,
    context.environment,
    params.assertCurrent,
  );
  if (!worktree || sessionWorktreeAvailability(worktree)?.status === "removed") {
    throw new SessionWorktreeUnavailableError(binding.id);
  }
  if (params.turn) {
    await recordRegistryWorktreeActivity(context.environment, worktree, assertCurrent);
  }
  return { worktree, assertCurrent, context };
}
