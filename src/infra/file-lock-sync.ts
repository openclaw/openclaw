import fs from "node:fs";
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
  const lock = acquireFileLockSync(path, {
    lockRoot,
    reentrantOwner,
    timeoutMs,
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
    shouldReclaim: isStale,
    shouldRemoveStaleLock: isStale,
  });
  return () => lock.release();
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
