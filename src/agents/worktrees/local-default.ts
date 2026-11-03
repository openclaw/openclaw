import { readFile } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "../../infra/errno.js";
import { enqueueGitRefMutation, executeGitCommand } from "../../infra/git-exec.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
import { commandError, listGitWorktrees, runGit } from "./git.js";

class LocalDefaultBusyError extends Error {}

async function assertWorktreeGitOperationsIdle(
  commonDir: string,
  localRef: string,
  options: NonNullable<Parameters<typeof runGit>[2]>,
): Promise<void> {
  try {
    const worktreesDir = path.join(commonDir, "worktrees");
    const worktrees = await fs
      .readdir(worktreesDir)
      .catch((error: unknown) => ignoreMissingPath(error) ?? []);
    const busy = () =>
      new LocalDefaultBusyError(
        "Local default retained: finish or abort the Git rebase, am, or bisect operation reserving it before advancing it.",
      );
    const primary = await fs.readdir(commonDir);
    if (primary.some((name) => ["rebase-merge", "rebase-apply", "BISECT_LOG"].includes(name))) {
      throw busy();
    }
    // Expected-missing reservations otherwise pay fs/promises' rejection and async stack capture.
    const read = (directory: string, name: string) =>
      new Promise<string | undefined>((resolve, reject) => {
        readFile(path.join(directory, name), "utf8", (error, contents) => {
          if (error && error.code !== "ENOENT") {
            reject(error);
          } else {
            resolve(error ? undefined : contents);
          }
        });
      });
    // Rebase exec can reattach HEAD; reservations cannot be inferred from detached status.
    // Read only reservation files, with bounded I/O and no per-worktree directory listing.
    const checked = await runTasksWithConcurrency({
      limit: 16,
      errorMode: "stop",
      tasks: worktrees.map((name) => async () => {
        options.signal?.throwIfAborted();
        options.beforeRun?.();
        const directory = path.join(worktreesDir, name);
        for (const file of [
          "rebase-merge/head-name",
          "rebase-apply/head-name",
          "rebase-merge/update-refs",
        ]) {
          if ((await read(directory, file))?.trim().split("\n").includes(localRef)) {
            throw busy();
          }
        }
        const bisect = (await read(directory, "BISECT_START"))?.trim();
        if (bisect === localRef || bisect === localRef.slice("refs/heads/".length)) {
          if ((await read(directory, "BISECT_LOG")) !== undefined) {
            throw busy();
          }
        }
      }),
    });
    if (checked.hasError) {
      throw checked.firstError;
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    options.beforeRun?.();
    if (error instanceof LocalDefaultBusyError) {
      throw error;
    }
    throw new LocalDefaultBusyError(
      "Local default retained: Git worktree operation state could not be checked. Inspect Git worktree metadata before retrying.",
      { cause: error },
    );
  }
}

export async function fastForwardLocalDefault(
  { repoRoot, commonDir }: { repoRoot: string; commonDir: string },
  branch: string,
  commit: string,
  options: NonNullable<Parameters<typeof runGit>[2]>,
): Promise<string | undefined> {
  const localRef = `refs/heads/${branch}`;
  const local = await runGit(repoRoot, ["rev-parse", "--verify", localRef], options);
  if (local.termination !== "exit" || local.code !== 0 || local.stdout.trim() === commit) {
    return undefined;
  }
  const previous = local.stdout.trim();
  const ancestor = await runGit(
    repoRoot,
    ["merge-base", "--is-ancestor", previous, commit],
    options,
  );
  if (ancestor.termination !== "exit" || ancestor.code !== 0) {
    return undefined;
  }
  const primary = await runGit(repoRoot, ["symbolic-ref", "--quiet", "HEAD"], options);
  if (primary.termination !== "exit" || primary.code !== 0 || primary.stdout.trim() !== localRef) {
    return undefined;
  }
  const advanced = await enqueueGitRefMutation(
    repoRoot,
    commonDir,
    () =>
      withWorktreeGitConfig(repoRoot, true, options, async (git) => {
        try {
          await assertWorktreeGitOperationsIdle(commonDir, localRef, options);
          const checkouts = (await listGitWorktrees(repoRoot, options)).filter(
            (entry) => entry.branch === localRef,
          );
          const checkout = checkouts[0];
          if (
            !checkout ||
            checkouts.length > 1 ||
            path.resolve(checkout.path) !== path.resolve(repoRoot) ||
            checkout.lockedReason !== undefined
          ) {
            throw new LocalDefaultBusyError();
          }
          const sparse = await runGit(
            repoRoot,
            ["config", "--bool", "core.sparseCheckout"],
            options,
          );
          if (
            sparse.termination !== "exit" ||
            (sparse.code !== 0 && sparse.code !== 1) ||
            sparse.stdout.trim() === "true"
          ) {
            throw new LocalDefaultBusyError();
          }
          const dirty = await git.run(
            repoRoot,
            ["status", "--porcelain", "--untracked-files=all"],
            options,
          );
          if (dirty.termination !== "exit" || dirty.code !== 0 || dirty.stdout.trim()) {
            throw new LocalDefaultBusyError();
          }
          const current = await runGit(repoRoot, ["symbolic-ref", "--quiet", "HEAD"], options);
          if (
            current.termination !== "exit" ||
            current.code !== 0 ||
            current.stdout.trim() !== localRef
          ) {
            throw new LocalDefaultBusyError();
          }
          // This callback owns the ref queue already. Keep the trusted content
          // configuration without admitting a second, nested merge operation.
          return await git.withContentEnvironment((env) =>
            executeGitCommand(
              repoRoot,
              ["merge", "--ff-only", "--no-edit", "--no-stat", "--no-overwrite-ignore", commit],
              { ...options, env, killProcessTree: true },
            ),
          );
        } catch (error) {
          if (error instanceof LocalDefaultBusyError) {
            return error;
          }
          throw error;
        }
      }),
    options.signal,
  );
  if (advanced instanceof LocalDefaultBusyError) {
    return advanced.message || undefined;
  }
  if (advanced.termination !== "exit" || advanced.code !== 0) {
    return commandError("git fast-forward local default", advanced).message;
  }
  return undefined;
}
