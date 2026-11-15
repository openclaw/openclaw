import {
  captureWorktreeRegistryReadGuard,
  readLiveRegistryWorktreeByPath,
} from "../../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { localWorkspaceProjectionPath } from "./local-workspace-checkout.js";

/** Read the live backing without capturing, publishing, or stopping guest writers. */
export async function readLocalWorkspacePath(params: {
  cwd: string;
  worktreeId: string;
  assertCurrent?: () => void;
}) {
  const context = captureWorktreeRunEndContext(process.env);
  const accept = captureWorktreeRegistryReadGuard(context, "lifecycle");
  const worktree = await readLiveRegistryWorktreeByPath(context, params.cwd);
  const assertWorktreeCurrent = accept(worktree);
  const assertCurrent = () => {
    assertWorktreeCurrent();
    params.assertCurrent?.();
  };
  assertCurrent();
  if (!worktree) {
    return { root: params.cwd, assertCurrent };
  }
  if (worktree.id !== params.worktreeId) {
    throw new Error("Local sandbox workspace owner changed");
  }
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "localWorkspace.readBacking", input: { id: worktree.id } },
    { context, current: true, live: true },
  );
  assertCurrent();
  const row = reply?.row;
  if (
    row &&
    (worktree.ownerKind !== "session" ||
      row.session_key !== worktree.ownerId ||
      row.projection_path !== localWorkspaceProjectionPath({ worktree, env: context.environment }))
  ) {
    throw new Error("Local sandbox workspace owner changed");
  }
  return {
    root: row?.baseline_ref ? row.projection_path : params.cwd,
    worktreeId: worktree.id,
    assertCurrent,
  };
}
