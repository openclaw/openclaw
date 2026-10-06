import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireGit } from "./git.js";
import { readRegistryWorktrees } from "./registry-read.js";

const log = createSubsystemLogger("agents/worktrees");
const WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS = 30 * 60 * 1000;

type MaintenanceParams = {
  signal?: AbortSignal;
  commitGuard?: () => void;
  retryDeferred?: boolean;
};

export function createWorktreeGitMaintenance(env: NodeJS.ProcessEnv) {
  // A failed repository needs operator repair, not another hourly attempt.
  const failed = new Set<string>();
  return async (params: MaintenanceParams): Promise<void> => {
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      params.commitGuard?.();
    };
    assertCurrent();
    if (params.retryDeferred) {
      failed.clear();
    }
    const live = await readRegistryWorktrees(env, { liveOnly: true }).catch((error: unknown) => {
      assertCurrent();
      log.warn(`worktree Git maintenance inventory failed: ${String(error)}`);
      return [];
    });
    for (const repoRoot of new Set(live.map((record) => record.repoRoot))) {
      assertCurrent();
      if (failed.has(repoRoot)) {
        continue;
      }
      try {
        // Git runs these tasks in order. Repair pack lookup before graph traversal:
        // a stale multi-pack index can make the graph task consume the whole budget.
        await requireGit(
          repoRoot,
          [
            "maintenance",
            "run",
            "--auto",
            "--task=incremental-repack",
            "--task=commit-graph",
            "--task=loose-objects",
          ],
          {
            killProcessTree: true,
            lowerPriority: true,
            signal: params.signal,
            beforeRun: assertCurrent,
            timeoutMs: WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS,
          },
        );
      } catch (error) {
        assertCurrent();
        if (!failed.has(repoRoot)) {
          failed.add(repoRoot);
          log.warn(
            `worktree Git maintenance suspended for ${repoRoot}: ${String(error)}\nRepair the repository, then run openclaw worktrees gc --retry-deferred or restart the Gateway to retry.`,
          );
        }
      }
    }
  };
}
