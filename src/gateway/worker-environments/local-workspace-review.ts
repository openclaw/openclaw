import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import { resolveSessionWorktree } from "../../agents/worktrees/session-lifecycle.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { isPathInside } from "../../infra/path-guards.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";

/** Review consumes accepted source facts without reconciling or provisioning the workspace. */
export async function readLocalWorkspaceReviewBase(params: {
  agentId: string;
  sessionKey: string;
  entry: Pick<InternalSessionEntry, "sessionId" | "worktree">;
  cwd: string;
  assertCurrent: () => void;
}) {
  const binding = params.entry.worktree;
  if (!binding) {
    return undefined;
  }
  params.assertCurrent();
  const context = captureWorktreeRunEndContext(process.env);
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "localWorkspace.reviewBase", input: { id: binding.id } },
    { context, current: true, live: true },
  );
  params.assertCurrent();
  const row = reply?.row;
  if (
    row &&
    (row.worktree_id !== binding.id ||
      row.agent_id !== params.agentId ||
      row.session_key !== params.sessionKey ||
      row.session_id !== params.entry.sessionId)
  ) {
    throw new Error("Local workspace review binding belongs to another session incarnation");
  }
  const prepared = await resolveSessionWorktree({
    binding,
    sessionKey: params.sessionKey,
    assertCurrent: params.assertCurrent,
  });
  if (!prepared) {
    return undefined;
  }
  const { worktree, assertCurrent } = prepared;
  assertCurrent();
  if (!isPathInside(worktree.path, params.cwd)) {
    throw new Error("Local workspace review owner changed");
  }
  return row ? { baseCommit: row.base_commit, assertCurrent } : undefined;
}
