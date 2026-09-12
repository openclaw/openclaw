import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { splitNullBuffer } from "./git-path-inventory.js";
import { requireGitBuffer } from "./git.js";
import {
  hasSafeParentDirectories,
  inspectProvisionedFiles,
  lstatIfExists,
  normalizeRelativePath,
  resolveGitPath,
} from "./provisioned-file-inspection.js";
import {
  clearRegistryWorktreeProvisionedChunks,
  getRegistryWorktreeProvisionedChunk,
  insertRegistryWorktreeProvisionedChunk,
} from "./registry.js";
import type { ProvisionedFileState } from "./types.js";

async function copyProvisionedFile(params: {
  repoRoot: string;
  worktreePath: string;
  relativePath: string;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const normalized = normalizeRelativePath(params.relativePath);
  if (
    !normalized ||
    !(await hasSafeParentDirectories(params.repoRoot, normalized)) ||
    !(await hasSafeParentDirectories(params.worktreePath, normalized))
  ) {
    return false;
  }
  const source = resolveGitPath(params.repoRoot, normalized);
  const destination = resolveGitPath(params.worktreePath, normalized);
  const sourceStat = await fs.lstat(source).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
    return false;
  }
  params.assertCurrent?.();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    params.assertCurrent?.();
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Existing checkout state is user-owned. Never mutate or claim it as provisioned.
      return false;
    }
    throw error;
  }
  params.assertCurrent?.();
  await fs.chmod(destination, sourceStat.mode);
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
  const provisioned: string[] = [];
  for (const relativePath of inspection.paths) {
    const normalized = normalizeRelativePath(relativePath);
    if (
      normalized &&
      (await copyProvisionedFile({
        repoRoot,
        worktreePath,
        relativePath: normalized,
        assertCurrent,
      }))
    ) {
      provisioned.push(normalized);
    }
  }
  return provisioned.toSorted();
}

type DirectoryIdentity = {
  path: string;
  dev: number;
  ino: number;
};

export const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

async function captureParentDirectoryIdentities(
  root: string,
  relativePath: string,
): Promise<DirectoryIdentity[]> {
  const segments = relativePath.split("/");
  const directories = [root];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  const identities: DirectoryIdentity[] = [];
  for (const directory of directories) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`unsafe provisioned parent directory: ${directory}`);
    }
    identities.push({ path: directory, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

async function validateDirectoryIdentities(identities: readonly DirectoryIdentity[]) {
  for (const identity of identities) {
    const stat = await fs.lstat(identity.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino
    ) {
      throw new Error(`provisioned parent directory changed: ${identity.path}`);
    }
  }
}

function sameFileState(left: Awaited<ReturnType<FileHandle["stat"]>>, right: typeof left) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

// Membership is fresh at capture time: earlier inventories can outlive an ignore/index change.
async function readProvisionedMembership(
  worktreePath: string,
  paths: readonly string[],
  options: { signal?: AbortSignal; beforeRun?: () => void },
) {
  const ignoredUntracked = new Set<string>();
  const currentTracked = new Set<string>();
  const trackedAtHead = new Set<string>();
  let offset = 0;
  while (offset < paths.length) {
    const batch: string[] = [];
    let bytes = 0;
    while (
      offset < paths.length &&
      (batch.length === 0 || (batch.length < 128 && bytes < 16_384))
    ) {
      const entry = paths[offset++]!;
      batch.push(entry);
      bytes += Buffer.byteLength(entry) + 1;
    }
    for (const [target, args] of [
      [ignoredUntracked, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]],
      [currentTracked, ["ls-files", "--cached", "-z"]],
      [trackedAtHead, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]],
    ] as const) {
      const output = await requireGitBuffer(
        worktreePath,
        ["--literal-pathspecs", ...args, "--", ...batch],
        { ...options, killProcessTree: true },
      );
      for (const entry of splitNullBuffer(output)) {
        target.add(entry.toString("utf8"));
      }
    }
  }
  return { ignoredUntracked, currentTracked, trackedAtHead };
}

/** Stores provisioned bytes outside Git so ignored credentials never enter its object database. */
export async function snapshotProvisionedFiles(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  worktreePath: string,
  provisionedPaths: readonly string[] | undefined,
  options: { signal?: AbortSignal; assertCurrent?: () => void } = {},
): Promise<ProvisionedFileState[]> {
  const commitGuard = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
  };
  const files = await inspectProvisionedFiles(worktreePath, provisionedPaths);
  if (files === undefined) {
    throw new Error("provisioned path ledger is unavailable");
  }
  if (files.every((file) => file.mode === null)) {
    commitGuard();
    clearRegistryWorktreeProvisionedChunks(env, worktreeId);
    return files.map((file) => ({ path: file.path, mode: null, chunks: 0 }));
  }
  const presentPaths = files.filter((file) => file.mode !== null).map((file) => file.path);
  const { ignoredUntracked, currentTracked, trackedAtHead } = await readProvisionedMembership(
    worktreePath,
    presentPaths,
    { signal: options.signal, beforeRun: commitGuard },
  );
  commitGuard();
  clearRegistryWorktreeProvisionedChunks(env, worktreeId);
  const states: ProvisionedFileState[] = [];
  try {
    for (const file of files) {
      if (file.mode === null) {
        states.push({ path: file.path, mode: null, chunks: 0 });
        continue;
      }
      if (currentTracked.has(file.path)) {
        throw new Error(`provisioned path is now tracked: ${file.path}`);
      }
      if (trackedAtHead.has(file.path)) {
        throw new Error(`provisioned path is tracked at HEAD: ${file.path}`);
      }
      if (!ignoredUntracked.has(file.path)) {
        throw new Error(`provisioned path is no longer ignored: ${file.path}`);
      }
      const parentIdentities = await captureParentDirectoryIdentities(worktreePath, file.path);
      const handle = await fs.open(
        file.target,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      try {
        await validateDirectoryIdentities(parentIdentities);
        const before = await handle.stat();
        const buffer = Buffer.allocUnsafe(SNAPSHOT_CHUNK_BYTES);
        let chunkIndex = 0;
        let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.byteLength, before.size - offset),
            offset,
          );
          if (bytesRead === 0) {
            throw new Error(`provisioned file changed while snapshotting: ${file.path}`);
          }
          commitGuard();
          insertRegistryWorktreeProvisionedChunk(env, {
            worktreeId,
            path: file.path,
            chunkIndex,
            data: buffer.subarray(0, bytesRead),
          });
          offset += bytesRead;
          chunkIndex += 1;
        }
        const [after, current] = await Promise.all([handle.stat(), fs.lstat(file.target)]);
        await validateDirectoryIdentities(parentIdentities);
        if (!sameFileState(before, after) || !sameFileState(before, current)) {
          throw new Error(`provisioned file changed while snapshotting: ${file.path}`);
        }
        states.push({ path: file.path, mode: before.mode & 0o7777, chunks: chunkIndex });
      } finally {
        await handle.close();
      }
    }
    return states;
  } catch (error) {
    clearRegistryWorktreeProvisionedChunks(env, worktreeId);
    throw error;
  }
}

async function writeAll(
  handle: FileHandle,
  data: Uint8Array,
  commitGuard?: () => void,
): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    commitGuard?.();
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset);
    if (bytesWritten === 0) {
      throw new Error("provisioned snapshot write made no progress");
    }
    offset += bytesWritten;
  }
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
    const normalized = normalizeRelativePath(state.path);
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
        const chunk = getRegistryWorktreeProvisionedChunk(env, {
          worktreeId,
          path: state.path,
          chunkIndex,
        });
        if (!chunk) {
          throw new Error(`provisioned snapshot chunk missing: ${state.path}:${chunkIndex}`);
        }
        await writeAll(handle, chunk, commitGuard);
      }
      commitGuard?.();
      await handle.chmod(state.mode);
      await validateDirectoryIdentities(parentIdentities);
    } finally {
      await handle.close();
    }
  }
}
