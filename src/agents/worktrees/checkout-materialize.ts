import type { GitCommandOptions } from "../../infra/git-exec.js";
import { withWorktreeGitConfig, type WorktreeGitPolicy } from "./checkout-git-config.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS, type GitResult } from "./git.js";

/** Materialization and restore share one filter-safe operation boundary. */
export async function materializeManagedWorktree(
  params: {
    destination: string;
    commit: string;
    sourceOnly?: boolean;
    resetIndexTo?: string;
    removeExisting?: boolean;
    preparedGit?: WorktreeGitPolicy;
    /** Native PR provisioning retains its caller-owned absolute deadline. */
    executionTimeoutMs?: number;
  },
  options: GitCommandOptions,
  indexOptions: GitCommandOptions = options,
): Promise<GitResult> {
  const materialize = async (git: WorktreeGitPolicy) => {
    if (params.removeExisting) {
      await git.require(
        params.destination,
        ["rm", "-r", "--force", "--ignore-unmatch", "--", "."],
        options,
      );
    }
    const result = await git.run(
      params.destination,
      ["read-tree", "--verbose", "--reset", "--no-recurse-submodules", "-u", params.commit],
      {
        ...options,
        env: { ...options.env, GIT_NO_LAZY_FETCH: "1" },
        // Git emits progress as files complete. Storage contention must not
        // kill a progressing checkout merely because five minutes elapsed.
        waitForExit: params.executionTimeoutMs === undefined,
        timeoutMs: params.executionTimeoutMs ?? options.timeoutMs,
        noOutputTimeoutMs:
          params.executionTimeoutMs === undefined ? WORKTREE_CHECKOUT_TIMEOUT_MS : undefined,
      },
    );
    if (result.code === 0 && params.resetIndexTo) {
      await git.require(
        params.destination,
        params.sourceOnly ? ["read-tree", "--reset", params.resetIndexTo] : ["reset"],
        indexOptions,
      );
    }
    return result;
  };
  return params.preparedGit
    ? await materialize(params.preparedGit)
    : await withWorktreeGitConfig(
        params.destination,
        params.sourceOnly === true,
        indexOptions,
        materialize,
      );
}
