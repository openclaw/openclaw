import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./file-lock.js";

const STALE_REF_LOCK_MS = 60 * 60_000;
// Linux local filesystems only: remote storage can retain another host's live writer.
const LOCAL_FILESYSTEM_TYPES = new Set([0xef53, 0x58465342, 0x9123683e, 0xf2f52010]);

function sameLock(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    right.nlink === 1 &&
    right.size === 0 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

async function regularRefPath(commonDirectory: string, relative: string): Promise<boolean> {
  let directory = commonDirectory;
  for (const component of relative.split(path.sep).slice(0, -1)) {
    directory = path.join(directory, component);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory()) {
      return false;
    }
  }
  return true;
}

/** Reclaim only native Git locks whose exclusive-create owner cannot have survived this boot. */
export async function clearStaleGitRemoteRefLocks(params: {
  commonDirectory: string;
  refs: readonly string[];
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<number> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  if (process.platform !== "linux" || params.refs.length === 0) {
    return 0;
  }
  const storage = await fs
    .realpath(params.commonDirectory)
    .then(async (commonDirectory) => ({
      commonDirectory,
      filesystem: await fs.statfs(commonDirectory),
      directory: await fs.stat(commonDirectory),
    }))
    .catch(() => undefined);
  assertCurrent();
  if (!storage || !LOCAL_FILESYSTEM_TYPES.has(storage.filesystem.type)) {
    return 0;
  }
  const { commonDirectory, directory } = storage;
  try {
    // Git's empty locks have no owner payload. Serialize reclaimers separately,
    // so a second process cannot unlink a new Git lock after the first removes the old one.
    return await withFileLock(
      path.join(commonDirectory, "openclaw-ref-lock-repair"),
      {
        retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
        stale: 0,
        staleRecovery: "remove-if-definitely-stale",
      },
      async () => {
        assertCurrent();
        // Empty Git ref locks carry no PID. Age alone, or a missing open descriptor,
        // cannot exclude a suspended writer between close and rename. A local inode
        // created before this boot has no surviving native Git owner.
        const cutoff = Date.now() - os.uptime() * 1_000 - STALE_REF_LOCK_MS;
        let cleared = 0;
        for (const ref of new Set(params.refs)) {
          assertCurrent();
          const relative = `${ref}.lock`;
          const target = path.resolve(commonDirectory, relative);
          if (
            !ref.startsWith("refs/remotes/origin/") ||
            path.relative(commonDirectory, target) !== relative
          ) {
            continue;
          }
          try {
            const observed = await fs.lstat(target);
            if (
              !observed.isFile() ||
              observed.nlink !== 1 ||
              observed.size !== 0 ||
              observed.dev !== directory.dev ||
              observed.birthtimeMs <= 0 ||
              Math.max(observed.birthtimeMs, observed.ctimeMs, observed.mtimeMs) >= cutoff ||
              !(await regularRefPath(commonDirectory, relative))
            ) {
              continue;
            }
            const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              if (
                !sameLock(observed, await handle.stat()) ||
                !(await regularRefPath(commonDirectory, relative)) ||
                !sameLock(observed, await fs.lstat(target))
              ) {
                continue;
              }
              assertCurrent();
              await fs.unlink(target);
              cleared++;
            } finally {
              await handle.close();
            }
          } catch {
            assertCurrent();
            // An unreadable or changing path is not proof of an abandoned ref lock.
          }
        }
        return cleared;
      },
    );
  } catch {
    assertCurrent();
    // Another reclaimer, or uncertain lock ownership, keeps native locks intact.
    return 0;
  }
}
