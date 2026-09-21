import { resolveStateDir } from "../../config/paths.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { requireWorktreeDiskSpace } from "./capacity.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import { removeUnusedEmptyWorktreeSource } from "./empty-source.js";
import { requireGit, worktreePathExists } from "./git.js";
import { snapshotProvisionedFiles } from "./provisioned-files.js";
import { deleteRegistryWorktree } from "./registry.js";
import type { ManagedWorktreeRecord } from "./types.js";

/** Existing snapshot worker and effect owners, supplied with this operation's Git policy. */
export async function captureManagedWorktreeSnapshot(params: {
  record: ManagedWorktreeRecord;
  env: NodeJS.ProcessEnv;
  reason: string;
  provisionedPaths: readonly string[];
  git: WorktreeGitPolicy;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}) {
  const { record, env, provisionedPaths } = params;
  return await runGitWorkerOperation(
    {
      type: "worktree.snapshot",
      input: {
        worktreeId: record.id,
        checkoutPath: record.path,
        repoRoot: record.repoRoot,
        reason: params.reason,
        provisionedPaths,
      },
    },
    {
      signal: params.signal,
      assertCurrent: params.assertCurrent,
      git: params.git.worker,
      onEffect: async (effect, { signal }) => {
        const assertCurrent = () => {
          signal.throwIfAborted();
          params.assertCurrent?.();
        };
        assertCurrent();
        switch (effect.type) {
          case "worktree.assert-current":
            return undefined;
          case "worktree.snapshot-capacity":
            requireWorktreeDiskSpace(
              [
                ...effect.input.demands,
                ...(effect.input.stateBytes === undefined
                  ? []
                  : [{ path: resolveStateDir(env), bytes: effect.input.stateBytes }]),
              ],
              effect.input.purpose,
              true,
            );
            return undefined;
          case "worktree.snapshot-provisioned":
            return await snapshotProvisionedFiles(env, record.id, record.path, provisionedPaths, {
              signal,
              assertCurrent,
            });
        }
        return undefined;
      },
    },
  );
}

/** Retire the restore entry point before releasing accepted projection custody. */
export async function retireManagedWorktreeSnapshot(params: {
  record: ManagedWorktreeRecord;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
}) {
  const { record, env, signal, assertCurrent } = params;
  const { expireLocalWorkspaceProjection } =
    await import("../../gateway/worker-environments/local-workspace-projection.js");
  await expireLocalWorkspaceProjection({
    worktree: record,
    env,
    assertCurrent,
    retireSnapshot: async (assertProjectionCurrent) => {
      const beforeRun = () => {
        assertCurrent();
        assertProjectionCurrent();
      };
      if (await worktreePathExists(record.repoRoot)) {
        if (record.snapshotRef) {
          await requireGit(record.repoRoot, ["update-ref", "-d", record.snapshotRef], {
            signal,
            beforeRun,
          });
        }
        // Snapshot-loss removal can leave only a pending HEAD pin. Keep its
        // registry owner until that pin has been cleared too.
        await requireGit(
          record.repoRoot,
          ["update-ref", "-d", "refs/openclaw/removals/" + record.id],
          { signal, beforeRun },
        );
      }
    },
  });
  await removeUnusedEmptyWorktreeSource({ env, record, signal, commitGuard: assertCurrent });
  assertCurrent();
  deleteRegistryWorktree(env, record.id);
}
