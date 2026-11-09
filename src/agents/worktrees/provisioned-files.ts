import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWindowFully } from "../../infra/file-descriptor.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { lstatIfExists } from "../../infra/path-existence.js";
import { timeWorktreePreparationPhase } from "./preparation-timing.js";
import { copyProvisionedPathsInWorker } from "./provisioned-copy-host.js";
import {
  captureParentDirectoryIdentities,
  hasSafeParentDirectories,
  normalizeProvisionedRelativePath,
  resolveGitPath,
  validateDirectoryIdentities,
} from "./provisioned-file-inspection.js";
import { getRegistryWorktreeProvisionedChunk } from "./registry-read.js";
import type { ProvisionedFileState } from "./types.js";

/** Copies the current manifest matches and returns only paths this call actually created. */
export async function provisionIncludedFiles(
  repoRoot: string,
  worktreePath: string,
  options: { signal?: AbortSignal; assertCurrent?: () => void } = {},
): Promise<string[]> {
  const inspection = await timeWorktreePreparationPhase("provisionInspect", () =>
    runGitWorkerOperation(
      {
        type: "worktree.provisioning-inspection",
        input: { sourceRoot: repoRoot, estimateBytes: false },
      },
      options,
    ),
  );
  if (inspection.paths.length === 0) {
    return [];
  }
  return await copyProvisionedPathsInWorker(repoRoot, worktreePath, inspection.paths, options);
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
      if (await lstatIfExists(target, "ENOENT")) {
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
