import { statSync } from "node:fs";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../../infra/disk-space.js";
import { runGitWorkerOperation, type GitWorkerOperationOptions } from "../../infra/git-worker.js";

const GiB = 1024 ** 3;
export const WORKTREE_SETUP_HEADROOM_BYTES = 4 * GiB;

/** Admission estimates allocations, not a quota on arbitrary repository scripts or other writers. */
export function requireWorktreeDiskSpace(
  demands: readonly { path: string; bytes: number }[],
  purpose: string,
  snapshot = false,
): void {
  const volumes = new Map<
    number,
    { path: string; available: number; total: number; bytes: number }
  >();
  for (const demand of demands) {
    const space = tryReadDiskSpace(demand.path);
    if (!space || space.totalBytes === null) {
      throw new Error(
        `Cannot determine disk space near ${demand.path}; check the volume and retry ${purpose}.`,
      );
    }
    const device = statSync(space.checkedPath).dev;
    const existing = volumes.get(device);
    if (existing) {
      existing.available = Math.min(existing.available, space.availableBytes);
      existing.bytes += demand.bytes;
    } else {
      volumes.set(device, {
        path: space.checkedPath,
        available: space.availableBytes,
        total: space.totalBytes,
        bytes: demand.bytes,
      });
    }
  }
  for (const volume of volumes.values()) {
    // Cleanup must still be possible below the operational reserve, but never without snapshot room.
    const reserve = snapshot
      ? 128 * 1024 ** 2
      : Math.max(4 * GiB, Math.min(volume.total / 10, 16 * GiB));
    const required = reserve + volume.bytes;
    if (!Number.isSafeInteger(Math.ceil(required)) || volume.available < required) {
      throw new Error(
        `Insufficient disk space near ${volume.path} for ${purpose}: ${formatDiskSpaceBytes(volume.available)} available; approximately ${formatDiskSpaceBytes(required)} required including safety reserve. Free caches or archive/remove unused worktrees, then retry.`,
      );
    }
  }
}

export async function estimateWorktreeGitBytes(
  repoRoot: string,
  ref: string,
  options: Pick<GitWorkerOperationOptions, "signal" | "assertCurrent"> = {},
): Promise<number> {
  return await runGitWorkerOperation(
    { type: "worktree.git-size", input: { repoRoot, ref } },
    options,
  );
}

/** Each call measures current files; allocation cannot use a settled directory-size cache. */
export async function directorySizeBytes(
  root: string,
  excludeGit = false,
  options: Pick<GitWorkerOperationOptions, "signal" | "assertCurrent"> = {},
): Promise<number> {
  return await runGitWorkerOperation(
    { type: "worktree.directory-size", input: { root, excludeGit } },
    options,
  );
}
