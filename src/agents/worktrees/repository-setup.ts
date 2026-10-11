import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { createCommandError } from "../../process/command-error.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import { requireAllocationSpace } from "./capacity.js";
import { timeWorktreePreparationPhase } from "./preparation-timing.js";
import { provisionIncludedFiles } from "./provisioned-files.js";
import { withWorktreeSource, type ResolvedRepository } from "./service-preparation.js";
import type { CreateManagedWorktreeParams } from "./types.js";

export type MaterializedRepositoryWorktree = {
  worktreePath: string;
  recordBase: string;
  provisionedBytes: number;
  setupBytes: number;
  runRepositorySetup: boolean;
};

export async function completeRepositoryWorktreeSetup(
  params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
  env: NodeJS.ProcessEnv,
  repository: ResolvedRepository,
  materialized: MaterializedRepositoryWorktree,
): Promise<string[]> {
  const { worktreePath, provisionedBytes, setupBytes, runRepositorySetup } = materialized;
  const provisionedPaths =
    params.provisionIgnoredFiles === false
      ? []
      : await withWorktreeSource(params, async (current) => {
          current.signal?.throwIfAborted();
          current.commitGuard?.();
          await requireAllocationSpace(
            current,
            env,
            worktreePath,
            repository,
            2 * provisionedBytes + setupBytes,
          );
          return provisionIncludedFiles(repository.sourceRoot, worktreePath, {
            signal: current.signal,
            assertCurrent: current.commitGuard,
          });
        });
  if (runRepositorySetup) {
    await requireAllocationSpace(params, env, worktreePath, repository, setupBytes);
    await timeWorktreePreparationPhase("setup", () =>
      runSetupScript(repository.sourceRoot, worktreePath, params),
    );
  }
  return provisionedPaths;
}

async function runSetupScript(
  repoRoot: string,
  worktreePath: string,
  params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
): Promise<void> {
  const setupScript = path.join(repoRoot, ".openclaw", "worktree-setup.sh");
  const stat = await fs.stat(setupScript).catch(() => undefined);
  if (!stat?.isFile() || (stat.mode & 0o111) === 0) {
    return;
  }
  const timeoutMs = 120_000;
  params.onProgress?.("setup");
  // Checkout may outlive its caller. Revalidate before starting repository code,
  // then retain process ownership through cancellation and rollback.
  const runInCallerContext = AsyncLocalStorage.snapshot();
  const cancellation = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, cancellation.signal])
    : cancellation.signal;
  let pending: ReturnType<typeof runCommandWithTimeout> | undefined;
  let result: Awaited<ReturnType<typeof runCommandWithTimeout>>;
  try {
    const operation = await withWorktreeSource(params, (current) => {
      current.signal?.throwIfAborted();
      current.commitGuard?.();
      // Spawn is synchronous; its continuation keeps the caller's original context.
      pending = runInCallerContext(() =>
        runCommandWithTimeout([setupScript], {
          timeoutMs,
          cwd: worktreePath,
          signal,
          killProcessTree: true,
          env: {
            OPENCLAW_SOURCE_TREE_PATH: repoRoot,
            OPENCLAW_WORKTREE_PATH: worktreePath,
          },
        }),
      );
      void pending.catch(() => undefined);
      return { completion: pending };
    });
    result = await operation.completion;
  } catch (error) {
    if (pending) {
      cancellation.abort(error);
      await pending.catch(() => undefined);
    }
    throw error;
  }
  params.signal?.throwIfAborted();
  if (result.code !== 0) {
    throw createCommandError("worktree setup", result, { timeoutMs });
  }
}
