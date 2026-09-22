import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { writeFileWindowFully } from "../../infra/file-descriptor.js";
import { root as fsRoot, FsSafeError, type Root } from "../../infra/fs-safe.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { gitPathspecBatches, splitNullBuffer } from "./git-path-inventory.js";
import { requireGitBuffer } from "./git.js";
import {
  hasSafeParentDirectories,
  inspectProvisionedFiles,
  lstatIfExists,
  normalizeProvisionedRelativePath,
  resolveGitPath,
} from "./provisioned-file-inspection.js";
import {
  clearRegistryWorktreeProvisionedChunks,
  getRegistryWorktreeProvisionedChunk,
  insertRegistryWorktreeProvisionedChunk,
} from "./registry.js";
import type { ExactProvisionedSnapshot } from "./snapshot-exact-state-contract.js";
import type { ProvisionedFileState } from "./types.js";

async function copyProvisionedFile(params: {
  sourceRoot: Root;
  destinationRoot: Root;
  relativePath: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  const normalized = normalizeProvisionedRelativePath(params.relativePath);
  // Eligibility checks preserve skip behavior; copyIn guards the later mutation.
  if (
    !normalized ||
    !(await hasSafeParentDirectories(params.sourceRoot.rootReal, normalized)) ||
    !(await hasSafeParentDirectories(params.destinationRoot.rootReal, normalized))
  ) {
    return false;
  }
  const source = resolveGitPath(params.sourceRoot.rootReal, normalized);
  const destination = resolveGitPath(params.destinationRoot.rootReal, normalized);
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
  for (const batch of gitPathspecBatches(paths)) {
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
  options: {
    signal?: AbortSignal;
    assertCurrent?: () => void;
    expected?: ExactProvisionedSnapshot;
  } = {},
): Promise<ProvisionedFileState[]> {
  const commitGuard = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
  };
  const files = await inspectProvisionedFiles(worktreePath, provisionedPaths);
  if (files === undefined) {
    throw new Error("provisioned path ledger is unavailable");
  }
  const expected = options.expected
    ? new Map(options.expected.files.map((file) => [file.path, file]))
    : undefined;
  if (
    expected &&
    (expected.size !== files.length ||
      files.some((file) => !expected.has(file.path) || expected.get(file.path)?.mode !== file.mode))
  ) {
    throw new Error("provisioned exact-state membership or modes changed after capture");
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
        const captured = expected?.get(file.path);
        if (
          captured &&
          (captured.size !== before.size || captured.mode !== (before.mode & 0o7777))
        ) {
          throw new Error(
            `provisioned exact-state size or mode changed after capture: ${file.path}`,
          );
        }
        const digest = options.expected
          ? createHash(options.expected.algorithm).update(`blob ${before.size}\0`)
          : undefined;
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
          digest?.update(buffer.subarray(0, bytesRead));
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
        if (digest && digest.digest("hex") !== captured?.blob) {
          throw new Error(`provisioned exact-state bytes changed after capture: ${file.path}`);
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
        const chunk = getRegistryWorktreeProvisionedChunk(env, {
          worktreeId,
          path: state.path,
          chunkIndex,
        });
        if (!chunk) {
          throw new Error(`provisioned snapshot chunk missing: ${state.path}:${chunkIndex}`);
        }
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
