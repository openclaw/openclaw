import { readLiveRegistryWorktreeByPath } from "../../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import { LocalWorkspaceConflictError } from "./local-workspace-conflict-error.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";

export async function acknowledgeLocalWorkspaceConflict(params: {
  cwd?: string;
  worktreeId?: string;
  path: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const context = captureWorktreeRunEndContext(process.env);
  const env = { ...process.env, ...context.environment };
  let worktreeId = params.worktreeId;
  if (!worktreeId && params.cwd) {
    const record = await readLiveRegistryWorktreeByPath(context, params.cwd);
    params.assertCurrent?.();
    if (!record) {
      return;
    }
    worktreeId = record.id;
  }
  if (!worktreeId) {
    return;
  }
  await withLocalWorkspaceStore(
    { worktreeId, env, assertCurrent: params.assertCurrent },
    async (store) => {
      const row = store.get();
      if (!row || row.pending_target !== "canonical") {
        return;
      }
      const checkpoint = row.checkpoint_json
        ? (JSON.parse(row.checkpoint_json) as Record<string, unknown>) // SAFETY: Checkpoint JSON deserializes to a key-value record.
        : {};
      const acknowledged = new Set(
        Array.isArray(checkpoint.acknowledgedPaths) ? checkpoint.acknowledgedPaths : [],
      );
      acknowledged.add(params.path);
      const previousRoot = checkpoint.previousRoot ?? row.baseline_ref ?? null;
      const resultingRoot = checkpoint.resultingRoot ?? row.baseline_ref ?? "";
      await store.update(row, {
        checkpoint_json: JSON.stringify({
          version: 1,
          kind: "scan",
          records: [],
          removed: [],
          ...checkpoint,
          previousRoot,
          resultingRoot,
          acknowledgedPaths: [...acknowledged],
        }),
      });
    },
  );
  if (params.cwd) {
    try {
      const { checkpointLocalWorkspacePath } = await import("./local-workspace-projection.js");
      await checkpointLocalWorkspacePath({ cwd: params.cwd, assertCurrent: params.assertCurrent });
    } catch (error) {
      if (!(error instanceof LocalWorkspaceConflictError)) {
        throw error;
      }
    }
  }
}
