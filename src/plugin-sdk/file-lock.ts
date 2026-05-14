import "../infra/fs-safe-defaults.js";
import fs from "node:fs/promises";
import {
  acquireFileLock as acquireFsSafeFileLock,
  drainFileLockManagerForTest,
  resetFileLockManagerForTest,
} from "@openclaw/fs-safe/file-lock";
import { isPidAlive } from "../shared/pid-alive.js";

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
  pid?: number;
  createdAt?: string;
};

export type FileLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
};

export const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";
export const FILE_LOCK_STALE_ERROR_CODE = "file_lock_stale";

export type FileLockTimeoutError = Error & {
  code: typeof FILE_LOCK_TIMEOUT_ERROR_CODE;
  lockPath: string;
};

export type FileLockStaleError = Error & {
  code: typeof FILE_LOCK_STALE_ERROR_CODE;
  lockPath: string;
};

const FILE_LOCK_MANAGER_KEY = "openclaw.plugin-sdk.file-lock";

type LockFileSnapshot = {
  raw: string;
  payload: Record<string, unknown> | null;
};

function readLockPayload(value: Record<string, unknown> | null): LockFilePayload | null {
  if (!value) {
    return null;
  }
  return {
    pid: typeof value.pid === "number" ? value.pid : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
  };
}

async function shouldReclaimPluginLock(params: {
  lockPath: string;
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs: number;
}): Promise<boolean> {
  const payload = readLockPayload(params.payload);
  if (payload?.pid && !isPidAlive(payload.pid)) {
    return true;
  }
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    return !Number.isFinite(createdAt) || params.nowMs - createdAt > params.staleMs;
  }
  return true;
}

function isFileLockError(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null)?.code === code;
}

async function readLockFileSnapshot(lockPath: string): Promise<LockFileSnapshot | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return {
      raw,
      payload:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null,
    };
  } catch {
    return { raw, payload: null };
  }
}

function shouldRemoveReportedStalePluginLock(params: {
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs: number;
}): boolean {
  const payload = readLockPayload(params.payload);
  if (payload?.pid) {
    return !isPidAlive(payload.pid);
  }
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    return !Number.isFinite(createdAt) || params.nowMs - createdAt > params.staleMs;
  }
  return true;
}

async function removeReportedStaleLockIfStillStale(params: {
  lockPath: string;
  staleMs: number;
}): Promise<boolean> {
  const snapshot = await readLockFileSnapshot(params.lockPath);
  if (!snapshot) {
    return true;
  }
  if (
    !shouldRemoveReportedStalePluginLock({
      payload: snapshot.payload,
      staleMs: params.staleMs,
      nowMs: Date.now(),
    })
  ) {
    return false;
  }

  const current = await readLockFileSnapshot(params.lockPath);
  if (!current) {
    return true;
  }
  if (current.raw !== snapshot.raw) {
    return false;
  }

  try {
    await fs.unlink(params.lockPath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function normalizeLockError(err: unknown): never {
  if ((err as { code?: unknown }).code === FILE_LOCK_TIMEOUT_ERROR_CODE) {
    throw Object.assign(new Error((err as Error).message), {
      code: FILE_LOCK_TIMEOUT_ERROR_CODE,
      lockPath: (err as { lockPath?: string }).lockPath ?? "",
    }) as FileLockTimeoutError;
  }
  if ((err as { code?: unknown }).code === FILE_LOCK_STALE_ERROR_CODE) {
    throw Object.assign(new Error((err as Error).message), {
      code: FILE_LOCK_STALE_ERROR_CODE,
      lockPath: (err as { lockPath?: string }).lockPath ?? "",
    }) as FileLockStaleError;
  }
  throw err;
}

export function resetFileLockStateForTest(): void {
  resetFileLockManagerForTest(FILE_LOCK_MANAGER_KEY, FILE_LOCK_MANAGER_KEY);
}

export async function drainFileLockStateForTest(): Promise<void> {
  await drainFileLockManagerForTest(FILE_LOCK_MANAGER_KEY, FILE_LOCK_MANAGER_KEY);
}

/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
export async function acquireFileLock(
  filePath: string,
  options: FileLockOptions,
): Promise<FileLockHandle> {
  while (true) {
    try {
      const lock = await acquireFsSafeFileLock(filePath, {
        managerKey: FILE_LOCK_MANAGER_KEY,
        staleMs: options.stale,
        retry: options.retries,
        allowReentrant: true,
        payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
        shouldReclaim: shouldReclaimPluginLock,
      });
      return { lockPath: lock.lockPath, release: lock.release };
    } catch (err) {
      if (isFileLockError(err, FILE_LOCK_STALE_ERROR_CODE)) {
        const lockPath = (err as { lockPath?: string }).lockPath;
        if (
          lockPath &&
          (await removeReportedStaleLockIfStillStale({
            lockPath,
            staleMs: options.stale,
          }))
        ) {
          continue;
        }
      }
      return normalizeLockError(err);
    }
  }
}

/** Run an async callback while holding a file lock, always releasing the lock afterward. */
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
