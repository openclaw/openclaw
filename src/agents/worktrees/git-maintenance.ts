import fs from "node:fs/promises";
import { isMissingPathError } from "../../infra/errors.js";
import { withContentGitSlot } from "../../infra/git-content-budget.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireGit, resolveGitMetadataPath } from "./git.js";
import { readRegistryWorktrees } from "./registry-read.js";

const log = createSubsystemLogger("agents/worktrees");
const WORKTREE_GIT_MAINTENANCE_TIMEOUT_MS = 30 * 60 * 1000;

type MaintenanceParams = {
  signal?: AbortSignal;
  commitGuard?: () => void;
  retryDeferred?: boolean;
};

/** Repair pack lookup even when the repository's broader maintenance is suspended. */
export async function repairWorktreePackIndex(
  repoRoot: string,
  params: Pick<MaintenanceParams, "signal" | "commitGuard"> = {},
): Promise<void> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
  };
  await withContentGitSlot(async () => {
    const options = {
      signal: params.signal,
      beforeRun: assertCurrent,
      killProcessTree: true,
      lowerPriority: true,
      env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    };
    const packDirectory = await resolveGitMetadataPath(repoRoot, "objects/pack", options);
    // Git rejects an empty pack directory; inspect only this shallow metadata directory.
    const packs = await fs.readdir(packDirectory).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    });
    assertCurrent();
    const indexes = packs.filter((name) => name.endsWith(".idx"));
    if (indexes.length > 0) {
      // Reusing a stale MIDX fails before discovery when it names a removed pack.
      await requireGit(repoRoot, ["multi-pack-index", "write", "--stdin-packs"], {
        ...options,
        input: `${indexes.join("\n")}\n`,
      });
    }
  }, params.signal);
}

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
        await repairWorktreePackIndex(repoRoot, params);
        await withContentGitSlot(
          () =>
            requireGit(
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
                // Missing promisor objects belong to explicit fetches, not hourly housekeeping.
                env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
              },
            ),
          params.signal,
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
