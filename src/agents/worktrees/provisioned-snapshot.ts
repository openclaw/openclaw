import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { requestGitWorkerEffect } from "../../infra/git-worker-context.js";
import { gitPathspecBatches, splitNullBuffer } from "./git-path-inventory.js";
import { requireGitBuffer } from "./git.js";
import {
  captureParentDirectoryIdentities,
  inspectProvisionedFiles,
  validateDirectoryIdentities,
} from "./provisioned-file-inspection.js";
import type { ExactProvisionedSnapshot } from "./snapshot-exact-state-contract.js";
import type { ProvisionedFileState } from "./types.js";

export const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

const resetChunks = () =>
  requestGitWorkerEffect<"worktree.snapshot-provisioned-reset">({
    type: "worktree.snapshot-provisioned-reset",
    input: {},
  });

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
async function readProvisionedMembership(worktreePath: string, paths: readonly string[]) {
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
        { killProcessTree: true },
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
  worktreePath: string,
  provisionedPaths: readonly string[] | undefined,
  expectedSnapshot?: ExactProvisionedSnapshot,
): Promise<ProvisionedFileState[]> {
  const files = await inspectProvisionedFiles(worktreePath, provisionedPaths);
  if (files === undefined) {
    throw new Error("provisioned path ledger is unavailable");
  }
  const expected = expectedSnapshot
    ? new Map(expectedSnapshot.files.map((file) => [file.path, file]))
    : undefined;
  if (
    expected &&
    (expected.size !== files.length ||
      files.some((file) => !expected.has(file.path) || expected.get(file.path)?.mode !== file.mode))
  ) {
    throw new Error("provisioned exact-state membership or modes changed after capture");
  }
  if (files.every((file) => file.mode === null)) {
    await resetChunks();
    return files.map((file) => ({ path: file.path, mode: null, chunks: 0 }));
  }
  const presentPaths = files.filter((file) => file.mode !== null).map((file) => file.path);
  const { ignoredUntracked, currentTracked, trackedAtHead } = await readProvisionedMembership(
    worktreePath,
    presentPaths,
  );
  await resetChunks();
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
        const digest = expectedSnapshot
          ? createHash(expectedSnapshot.algorithm).update(`blob ${before.size}\0`)
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
          await requestGitWorkerEffect<"worktree.snapshot-provisioned-chunk">({
            type: "worktree.snapshot-provisioned-chunk",
            input: { path: file.path, chunkIndex, data: buffer.subarray(0, bytesRead) },
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
    await resetChunks();
    throw error;
  }
}
