import fs from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";

export type FileLockOptions = {
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize?: boolean;
  };
  stale: number;
};

type LockFilePayload = {
  pid: number;
  createdAt: string;
};

type HeldLock = {
  count: number;
  handle: fs.FileHandle;
  lockPath: string;
};

const HELD_LOCKS_KEY = Symbol.for("openclaw.fileLockHeldLocks");
const HELD_LOCKS = resolveProcessScopedMap<HeldLock>(HELD_LOCKS_KEY);

function computeDelayMs(retries: FileLockOptions["retries"], attempt: number): number {
  const base = Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt),
  );
  const jitter = retries.randomize ? 1 + Math.random() : 1;
  return Math.min(retries.maxTimeout, Math.round(base * jitter));
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") {
      return null;
    }
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function resolveNormalizedFilePath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  try {
    const realDir = await fs.realpath(dir);
    return path.join(realDir, path.basename(resolved));
  } catch {
    return resolved;
  }
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const payload = await readLockPayload(lockPath);
  // A lock file with missing or unparseable content was left by a process
  // that crashed between open("wx") (which creates the file) and the
  // subsequent writeFile (which fills in the pid/createdAt). Treat it as
  // stale immediately so it can be reclaimed rather than blocking every
  // future writer until the mtime-based timeout expires.
  if (payload === null) {
    return true;
  }
  if (!isPidAlive(payload.pid)) {
    return true;
  }
  const createdAt = Date.parse(payload.createdAt);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) {
    return true;
  }
  return false;
}

export type FileLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
};

async function releaseHeldLock(normalizedFile: string): Promise<void> {
  const current = HELD_LOCKS.get(normalizedFile);
  if (!current) {
    return;
  }
  current.count -= 1;
  if (current.count > 0) {
    return;
  }
  HELD_LOCKS.delete(normalizedFile);
  await current.handle.close().catch(() => undefined);
  await fs.rm(current.lockPath, { force: true }).catch(() => undefined);
}

export async function acquireFileLock(
  filePath: string,
  options: FileLockOptions,
): Promise<FileLockHandle> {
  const normalizedFile = await resolveNormalizedFilePath(filePath);
  const lockPath = `${normalizedFile}.lock`;
  const held = HELD_LOCKS.get(normalizedFile);
  if (held) {
    held.count += 1;
    return {
      lockPath,
      release: () => releaseHeldLock(normalizedFile),
    };
  }

  const attempts = Math.max(1, options.retries.retries + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
      HELD_LOCKS.set(normalizedFile, { count: 1, handle, lockPath });
      return {
        lockPath,
        release: () => releaseHeldLock(normalizedFile),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        throw err;
      }

      // Snapshot the inode of the existing lock file *before* checking
      // staleness.  We compare it again just before unlinking; if the inode
      // has changed in the interim, another waiter already reclaimed the
      // stale file and created a fresh lock — deleting it would silently
      // break that holder's mutual exclusion guarantee.
      const staleIno = await fs
        .stat(lockPath)
        .then((s) => s.ino)
        .catch(() => -1);

      // staleIno === -1 means the file vanished between open(EEXIST) and
      // stat — another process already removed it.  Skip straight to the
      // next open(O_EXCL) attempt.
      const isStale = staleIno === -1 || (await isStaleLock(lockPath, options.stale));

      if (isStale) {
        if (staleIno !== -1) {
          // Re-verify the path still maps to the same inode we deemed stale.
          // If it changed, a concurrent waiter beat us to the reclaim and has
          // already written its own fresh lock; leave that file alone.
          const currentIno = await fs
            .stat(lockPath)
            .then((s) => s.ino)
            .catch(() => -1);
          if (currentIno === staleIno) {
            await fs.rm(lockPath, { force: true }).catch(() => undefined);
          }
        }
        // Retry open(O_EXCL) regardless: either we removed the stale lock or
        // a concurrent waiter already handled it; either way, the path is now
        // either free or holds a fresh lock that isStaleLock will reject.
        continue;
      }

      if (attempt >= attempts - 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
    }
  }

  throw new Error(`file lock timeout for ${normalizedFile}`);
}

export async function withFileLock<T>(
  filePath: string,
  options: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireFileLock(filePath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
