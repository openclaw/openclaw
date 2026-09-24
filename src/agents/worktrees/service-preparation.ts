import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createCommandError } from "../../process/command-error.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import {
  commandError,
  listGitWorktrees,
  worktreePathExists,
  requireGit,
  resolveGitRepositoryPaths,
  runGit,
  type GitResult,
} from "./git.js";
import { worktreeOwnerMatches } from "./owner.js";
import { listRegistryWorktrees } from "./registry.js";
import { resolveCheckoutRootFromRealPath } from "./repository-paths.js";
import type { CreateManagedWorktreeParams } from "./types.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function withWorktreeSource<T>(
  params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
  run: (current: CreateManagedWorktreeParams & WorktreeAllocationGuard) => T | Promise<T>,
): Promise<T> {
  const { withSource, ...operation } = params;
  if (!withSource) {
    return await run(operation);
  }
  params.commitGuard?.();
  return await withSource((source) => {
    const commitGuard = () => {
      params.commitGuard?.();
      source.assertCurrent();
    };
    commitGuard();
    const signal =
      params.signal && source.signal
        ? AbortSignal.any([params.signal, source.signal])
        : (source.signal ?? params.signal);
    const rollbackGuard = () => {
      params.rollbackGuard();
      source.assertCheckoutCurrent?.();
    };
    return run({ ...operation, signal, commitGuard, rollbackGuard });
  });
}

export function validateName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error("worktree name must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return name;
}

export function findWorktreeByName(env: NodeJS.ProcessEnv, fingerprint: string, name: string) {
  return listRegistryWorktrees(env).find(
    (record) => record.repoFingerprint === fingerprint && record.name === name,
  );
}

async function nameIsUnavailable(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  fingerprint: string,
  root: string,
  name: string,
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
): Promise<boolean> {
  const worktreePath = path.join(root, name);
  const registered = findWorktreeByName(env, fingerprint, name);
  if (
    owner.ownerId &&
    registered &&
    registered.removedAt === undefined &&
    worktreeOwnerMatches(registered, owner)
  ) {
    // Let createForRepository reuse the caller's live checkout; a collision here
    // could mint a second checkout for one owner. Removed records stay collisions:
    // restore is explicit-name/id only, so a generated name (title slug or random
    // crustacean) must never silently resurrect a retired checkout.
    return false;
  }
  if (registered || (await worktreePathExists(worktreePath))) {
    return true;
  }
  const branch = `openclaw/${name}`;
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (branchExists.code === 0) {
    return true;
  }
  if (branchExists.code !== 1) {
    throw commandError("git show-ref --verify", branchExists);
  }
  return (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
}

function appendNameOrdinal(name: string, ordinal: number): string {
  const suffix = `-${ordinal}`;
  return `${name.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

export async function generateName(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  fingerprint: string,
  root: string,
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
  suggestedName: string,
): Promise<string> {
  validateName(suggestedName);
  for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
    const candidate = ordinal === 1 ? suggestedName : appendNameOrdinal(suggestedName, ordinal);
    if (!(await nameIsUnavailable(env, repoRoot, fingerprint, root, candidate, owner))) {
      return candidate;
    }
  }
  throw new Error(`no available worktree name for ${suggestedName}`);
}

export type ResolvedRepository = {
  repoRoot: string;
  sourceRoot: string;
  commonDir: string;
  originUrl: string;
  fingerprint: string;
};

export async function resolveRepositoryFromRealPath(
  requested: string,
  requestedLabel: string,
): Promise<ResolvedRepository> {
  const sourceRoot = await resolveCheckoutRootFromRealPath(requested, requestedLabel);
  const { canonicalRoot, commonDir } = await resolveGitRepositoryPaths(sourceRoot);
  const origin = await runGit(canonicalRoot, ["config", "--get", "remote.origin.url"]);
  const originUrl = origin.code === 0 ? origin.stdout.trim() : "";
  const fingerprint = createHash("sha256")
    .update(`${commonDir}\n${originUrl}`)
    .digest("hex")
    .slice(0, 16);
  return { repoRoot: canonicalRoot, sourceRoot, commonDir, originUrl, fingerprint };
}

export async function resolveRepository(repoRoot: string): Promise<ResolvedRepository> {
  const requested = await fs.realpath(repoRoot).catch(() => {
    throw new Error(`repository does not exist: ${repoRoot}`);
  });
  return await resolveRepositoryFromRealPath(requested, repoRoot);
}

export async function cleanupFailedCreate(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  rollbackGuard: () => void,
) {
  const options = { beforeRun: rollbackGuard, killProcessTree: true };
  const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath], options);
  const deletedBranch = await runGit(repoRoot, ["branch", "-D", branch], options);
  if (removed.code !== 0 || deletedBranch.code !== 0) {
    const failure =
      removed.code !== 0
        ? commandError("git worktree remove", removed)
        : commandError("git branch -D", deletedBranch);
    throw new Error(`failed to clean up worktree creation: ${failure.message}`);
  }
}

export async function resetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  rollbackGuard: () => void,
): Promise<void> {
  const options = { beforeRun: rollbackGuard, killProcessTree: true };
  const listed = (await listGitWorktrees(repoRoot, options)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed) {
    const removed = await runGit(
      repoRoot,
      ["worktree", "remove", "--force", worktreePath],
      options,
    );
    if (removed.code !== 0) {
      throw commandError("git worktree remove", removed);
    }
  } else if (await worktreePathExists(worktreePath)) {
    // A failed add can leave an unregistered directory; it is safe debris once git omits it.
    rollbackGuard();
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
  const branchExists = await runGit(
    repoRoot,
    ["show-ref", "--quiet", "--verify", `refs/heads/${branch}`],
    options,
  );
  if (branchExists.code === 0) {
    await requireGit(repoRoot, ["branch", "-D", branch], options);
  }
}

export async function canResetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  failure: GitResult,
): Promise<boolean> {
  // Keep retry evidence unchanged: diagnostic rendering/truncation must never
  // grant cleanup or retry authority.
  const message = (failure.stderr || failure.stdout).trim().split("\n").slice(-12).join("\n");
  const createdBranch = message.includes(`Preparing worktree (new branch '${branch}')`);
  if (message.includes("unable to checkout working tree") || createdBranch) {
    return true;
  }
  const listed = (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed || (await worktreePathExists(worktreePath))) {
    return false;
  }
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  return branchExists.code === 1;
}

export async function runSetupScript(
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
