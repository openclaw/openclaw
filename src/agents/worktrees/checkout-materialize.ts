import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "../../infra/fs-safe.js";
import type { GitCommandOptions } from "../../infra/git-exec.js";
import { withWorktreeGitConfig, type WorktreeGitPolicy } from "./checkout-git-config.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS, type GitResult } from "./git.js";
import { timeWorktreePreparationPhase } from "./preparation-timing.js";

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

/** Install the cloned index, preserving APFS stat rebasing and the shared refresh boundary. */
export async function prepareClonedWorktreeIndex(
  params: {
    source: string;
    sourceIndex: string;
    destination: string;
    destinationIndex: string;
    apfsCloneCompletedAtMs?: number;
    sourceOnly?: boolean;
    checkoutBudget?: Pick<GitCommandOptions, "timeoutMs" | "killGraceMs">;
  },
  options: WorktreeFilesystemOptions,
): Promise<void> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.commitGuard();
  };
  await timeWorktreePreparationPhase("indexCopy", async () => {
    if (params.apfsCloneCompletedAtMs !== undefined) {
      const { copyApfsCloneIndex } = await import("./checkout-apfs.js");
      if (
        await copyApfsCloneIndex(
          params.source,
          params.destination,
          params.sourceIndex,
          params.destinationIndex,
          { ...options, cloneCompletedAtMs: params.apfsCloneCompletedAtMs },
        )
      ) {
        return;
      }
    }
    assertCurrent();
    const sourceIndex = await fs.realpath(params.sourceIndex);
    const [sourceRoot, destinationRoot] = await Promise.all([
      fsRoot(path.dirname(sourceIndex)),
      fsRoot(path.dirname(params.destinationIndex)),
    ]);
    await destinationRoot.copyIn(
      path.basename(params.destinationIndex),
      { root: sourceRoot, relativePath: `./${path.basename(sourceIndex)}` },
      {
        clone: "auto",
        durable: false,
        mkdir: false,
        overwrite: true,
        preserveSourceMode: true,
        sourceHardlinks: "allow",
        signal: options.signal,
        assertBeforeMutation: assertCurrent,
      },
    );
  });
  const gitOptions = { signal: options.signal, beforeRun: assertCurrent, killProcessTree: true };
  await timeWorktreePreparationPhase("indexRefresh", () =>
    withWorktreeGitConfig(params.destination, params.sourceOnly === true, gitOptions, (git) =>
      git.require(params.destination, ["update-index", "--refresh"], {
        ...gitOptions,
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
        ...params.checkoutBudget,
      }),
    ),
  );
}
