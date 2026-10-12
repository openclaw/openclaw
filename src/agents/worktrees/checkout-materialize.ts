import type { GitCommandOptions } from "../../infra/git-exec.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
import type { GitResult } from "./git.js";

/** Materialization and restore share one filter-safe operation boundary. */
export async function materializeManagedWorktree(
  params: {
    destination: string;
    commit: string;
    sourceOnly?: boolean;
    resetIndexTo?: string;
    removeExisting?: boolean;
  },
  options: GitCommandOptions,
  indexOptions: GitCommandOptions = options,
): Promise<GitResult> {
  return await withWorktreeGitConfig(
    params.destination,
    params.sourceOnly === true,
    indexOptions,
    async (git) => {
      if (params.removeExisting) {
        await git.require(
          params.destination,
          ["rm", "-r", "--force", "--ignore-unmatch", "--", "."],
          options,
        );
      }
      const result = await git.run(
        params.destination,
        ["read-tree", "--reset", "--no-recurse-submodules", "-u", params.commit],
        { ...options, env: { ...options.env, GIT_NO_LAZY_FETCH: "1" } },
      );
      if (result.code === 0 && params.resetIndexTo) {
        await git.require(
          params.destination,
          params.sourceOnly ? ["read-tree", "--reset", params.resetIndexTo] : ["reset"],
          indexOptions,
        );
      }
      return result;
    },
  );
}
