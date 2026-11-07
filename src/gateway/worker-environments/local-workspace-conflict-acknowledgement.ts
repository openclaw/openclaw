import { readLiveRegistryWorktreeByPath } from "../../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import { LocalWorkspaceConflictError } from "./local-workspace-conflict-error.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";

export async function acknowledgeLocalWorkspaceConflict(params: {
  cwd: string;
  path: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const context = captureWorktreeRunEndContext(process.env);
  const env = { ...process.env, ...context.environment };
  const record = await readLiveRegistryWorktreeByPath(context, params.cwd);
  params.assertCurrent?.();
  if (!record) {
    return;
  }
  await withLocalWorkspaceStore(
    { worktreeId: record.id, env, assertCurrent: params.assertCurrent },
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
      await store.update(row, {
        checkpoint_json: JSON.stringify({
          ...checkpoint,
          acknowledgedPaths: [...acknowledged],
        }),
      });
    },
  );
  try {
    const { checkpointLocalWorkspacePath } = await import("./local-workspace-projection.js");
    await checkpointLocalWorkspacePath({ cwd: params.cwd, assertCurrent: params.assertCurrent });
  } catch (error) {
    if (!(error instanceof LocalWorkspaceConflictError)) {
      throw error;
    }
  }
}
