import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWindowFully } from "../../infra/file-descriptor.js";
import { root as fsRoot, FsSafeError, type Root } from "../../infra/fs-safe.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { lstatIfExists } from "./git.js";
import {
  captureParentDirectoryIdentities,
  hasSafeParentDirectories,
  normalizeProvisionedRelativePath,
  resolveGitPath,
  validateDirectoryIdentities,
} from "./provisioned-file-inspection.js";
import { getRegistryWorktreeProvisionedChunk } from "./registry-read.js";
import type { ProvisionedFileState } from "./types.js";

async function copyProvisionedFile(params: {
  sourceRoot: Root;
  destinationRoot: Root;
  relativePath: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  const relativePath = params.relativePath;
  // Eligibility checks preserve skip behavior; copyIn guards the later mutation.
  if (
    !(await hasSafeParentDirectories(params.sourceRoot.rootReal, relativePath)) ||
    !(await hasSafeParentDirectories(params.destinationRoot.rootReal, relativePath))
  ) {
    return false;
  }
  const source = resolveGitPath(params.sourceRoot.rootReal, relativePath);
  const destination = resolveGitPath(params.destinationRoot.rootReal, relativePath);
  const sourceStat = await fs.lstat(source).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
    return false;
  }
  if (await lstatIfExists(destination)) {
    return false;
  }
  try {
    // Absolute spellings preserve Git's literal "~" and POSIX drive-like filenames.
    await params.destinationRoot.copyIn(
      destination,
      { root: params.sourceRoot, relativePath: source },
      {
        overwrite: false,
        maxBytes: Infinity,
        preserveSourceMode: true,
        sourceHardlinks: "allow",
        mutationSymlinks: "reject",
        durable: false,
        assertBeforeMutation: params.assertCurrent,
        signal: params.signal,
      },
    );
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "already-exists") {
      // Existing checkout state is user-owned. Never mutate or claim it as provisioned.
      return false;
    }
    throw error;
  }
  params.assertCurrent?.();
  return true;
}

/** Copies the current manifest matches and returns only paths this call actually created. */
export async function provisionIncludedFiles(
  repoRoot: string,
  worktreePath: string,
  options: { signal?: AbortSignal; assertCurrent?: () => void } = {},
): Promise<string[]> {
  const inspection = await runGitWorkerOperation(
    { type: "worktree.provisioning-inspection", input: { sourceRoot: repoRoot } },
    options,
  );
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
  };
  if (inspection.paths.length === 0) {
    return [];
  }
  assertCurrent();
  const [sourceRoot, destinationRoot] = await Promise.all([fsRoot(repoRoot), fsRoot(worktreePath)]);
  const provisioned: string[] = [];
  for (const relativePath of inspection.paths) {
    const normalized = normalizeProvisionedRelativePath(relativePath);
    if (
      normalized &&
      (await copyProvisionedFile({
        sourceRoot,
        destinationRoot,
        relativePath: normalized,
        assertCurrent,
        signal: options.signal,
      }))
    ) {
      provisioned.push(normalized);
    }
  }
  return provisioned.toSorted();
}

/** Restores provisioned bytes and modes from SQLite, never from the mutable source checkout. */
export async function restoreProvisionedFiles(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  worktreePath: string,
  states: readonly ProvisionedFileState[],
  commitGuard?: () => void,
): Promise<void> {
  for (const state of states) {
    const normalized = normalizeProvisionedRelativePath(state.path);
    if (!normalized || !(await hasSafeParentDirectories(worktreePath, normalized))) {
      throw new Error(`unsafe provisioned path: ${state.path}`);
    }
    const target = resolveGitPath(worktreePath, normalized);
    if (state.mode === null) {
      if (await lstatIfExists(target)) {
        throw new Error(`snapshot expected provisioned path to be absent: ${state.path}`);
      }
      continue;
    }
    commitGuard?.();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const parentIdentities = await captureParentDirectoryIdentities(worktreePath, normalized);
    commitGuard?.();
    const handle = await fs.open(
      target,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      state.mode,
    );
    try {
      await validateDirectoryIdentities(parentIdentities);
      for (let chunkIndex = 0; chunkIndex < state.chunks; chunkIndex += 1) {
        const chunk = await getRegistryWorktreeProvisionedChunk(env, {
          worktreeId,
          path: state.path,
          chunkIndex,
        });
        if (!chunk) {
          throw new Error(`provisioned snapshot chunk missing: ${state.path}:${chunkIndex}`);
        }
        commitGuard?.();
        await writeFileWindowFully(handle, chunk, null, { assertBeforeMutation: commitGuard });
      }
      commitGuard?.();
      await handle.chmod(state.mode);
      await validateDirectoryIdentities(parentIdentities);
    } finally {
      await handle.close();
    }
  }
}
