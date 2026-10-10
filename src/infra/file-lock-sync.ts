import fs from "node:fs";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { hasErrnoCode } from "./errno.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

/** Coordinate synchronous store access, reclaiming only definitely dead owners. */
export function acquireFileLockSyncWithRetry(
  path: string,
  options: Pick<
    Parameters<typeof acquireFileLockSync>[1],
    "lockRoot" | "reentrantOwner" | "timeoutMs"
  > = {},
): () => void {
  const lockPath = `${path}.lock`;
  const { lockRoot, reentrantOwner, timeoutMs } = options;
  const deadline =
    lockRoot && timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? performance.now() + timeoutMs
      : undefined;
  rejectUnsupportedLockPath(lockPath);
  const processStartTime = getFileLockProcessStartTime(process.pid);
  const createPayload = () => ({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...(processStartTime === null ? {} : { starttime: processStartTime }),
  });
  const isStale = ({ payload }: { payload: unknown }) =>
    isLockOwnerDefinitelyStale({
      payload: isRecord(payload) ? payload : null,
    });
  for (;;) {
    let reclaimObserved = false;
    try {
      const lock = acquireFileLockSync(path, {
        lockRoot,
        reentrantOwner,
        timeoutMs: deadline === undefined ? timeoutMs : Math.max(0, deadline - performance.now()),
        staleMs: 30_000,
        retry: {
          ...(timeoutMs === undefined ? { retries: 9 } : {}),
          factor: 1,
          minTimeout: 20,
          maxTimeout: 20,
          randomize: false,
        },
        staleRecovery: "remove-if-unchanged",
        payload: createPayload,
        shouldReclaim: (snapshot) => {
          reclaimObserved = false;
          const stale = isStale(snapshot);
          reclaimObserved = true;
          return stale;
        },
        shouldRemoveStaleLock: isStale,
      });
      return () => lock.release();
    } catch (error) {
      // fs-safe rechecks the sidecar after our callback. Only disappearance can
      // be a release; a surviving replacement or another authority failure refuses.
      if (
        deadline === undefined ||
        !reclaimObserved ||
        !(error instanceof FsSafeError) ||
        error.code !== "path-mismatch" ||
        error.message !== "sidecar changed during reclaim policy callback" ||
        !sidecarAbsent(lockPath)
      ) {
        throw error;
      }
      if (performance.now() >= deadline) {
        throw Object.assign(
          new Error(`Storage lock admission timed out: ${lockPath}`, { cause: error }),
          {
            code: "file_lock_timeout",
            lockPath,
          },
        );
      }
      // Re-observe through the same Root and its original remaining budget,
      // before any caller operation or SQLite transaction has been entered.
    }
  }
}

function sidecarAbsent(lockPath: string): boolean {
  try {
    fs.lstatSync(lockPath);
    return false;
  } catch (error) {
    return hasErrnoCode(error, "ENOENT");
  }
}

function rejectUnsupportedLockPath(lockPath: string): void {
  let observed: fs.Stats;
  try {
    observed = fs.lstatSync(lockPath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (observed.isFile() && !observed.isSymbolicLink()) {
    return;
  }
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new Error(`Storage lock path has an unsupported legacy type: ${lockPath}`);
  }
  throw Object.assign(
    new Error(
      `Legacy storage lock requires manual removal after verifying no older OpenClaw process is running: ${lockPath}`,
    ),
    { code: "file_lock_stale", lockPath },
  );
}
