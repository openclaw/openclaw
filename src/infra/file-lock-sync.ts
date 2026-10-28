import fs from "node:fs";
import pathModule from "node:path";
import { threadId } from "node:worker_threads";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { hasErrnoCode, ignoreMissingPath } from "./errno.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

/** Coordinate synchronous store access, recovering dead or unregistered self-held sidecars. */
export function acquireFileLockSyncWithRetry(
  path: string,
  options: Pick<
    Parameters<typeof acquireFileLockSync>[1],
    "lockRoot" | "reentrantOwner" | "timeoutMs"
  > & { phase?: string } = {},
): () => void {
  const startedAt = performance.now();
  const lockPath = `${path}.lock`;
  const { lockRoot, reentrantOwner, timeoutMs, phase = "storage-lock" } = options;
  const deadline =
    lockRoot && timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? performance.now() + timeoutMs
      : undefined;
  rejectUnsupportedLockPath(lockPath);
  let holder: ReturnType<typeof inspectFileLockHolder> | undefined;
  let reclaimed = false;
  const processStartTime = getFileLockProcessStartTime(process.pid);
  const createPayload = () => ({
    pid: process.pid,
    threadId,
    command: pathModule.basename(process.argv[1] ?? process.execPath),
    phase,
    createdAt: new Date().toISOString(),
    ...(processStartTime === null ? {} : { starttime: processStartTime }),
  });
  const isStale = ({ payload }: { payload: unknown }) => {
    holder = inspectFileLockHolder(payload);
    // fs-safe never offers a registered local holder for reclamation. A different
    // worker can share our PID, so its recorded thread must remain protected.
    return (
      (isRecord(payload) &&
        payload.pid === process.pid &&
        (payload.threadId === undefined || payload.threadId === threadId)) ||
      isLockOwnerDefinitelyStale({
        payload: isRecord(payload) ? payload : null,
      })
    );
  };
  const timeoutError = (cause: unknown) =>
    fileLockTimeoutError({
      cause,
      lockPath,
      startedAt,
      timeoutMs,
      phase,
      holder,
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
        shouldRemoveStaleLock: (snapshot) => (reclaimed = isStale(snapshot)),
      });
      if (reclaimed) {
        process.emitWarning(
          `Reclaimed stale file lock ${lock.lockPath}; previous holder pid=${holder?.pid ?? "unknown"} starttime=${holder?.starttime ?? "unknown"} alive=${holder?.alive ?? "unknown"}; waiting phase=${phase}`,
        );
      }
      return () => lock.release();
    } catch (error) {
      if (hasErrnoCode(error, "file_lock_timeout")) {
        throw timeoutError(error);
      }
      // A live holder can release during the reclaim callback. A surviving
      // replacement or any other authority failure must still refuse admission.
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
        throw timeoutError(error);
      }
      // Reacquire through the same Root and original budget before entering
      // caller work; an admitted database transaction is never replayed.
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
    ignoreMissingPath(error);
    return;
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

/** Diagnostic facts only; reclamation belongs to the provider's guarded callback. */
function inspectFileLockHolder(payload: unknown) {
  const record = isRecord(payload) ? payload : {};
  const pid =
    typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0
      ? record.pid
      : null;
  const label = (value: unknown) => (typeof value === "string" ? value.slice(0, 256) : null);
  return {
    pid,
    starttime: typeof record.starttime === "number" ? record.starttime : null,
    threadId: typeof record.threadId === "number" ? record.threadId : null,
    command: label(record.command),
    phase: label(record.phase),
    alive: pid === null ? null : isPidAlive(pid),
  };
}

/** Bounded regular sidecar metadata, including local holders that bypass stale policy. */
function readFileLockHolder(lockPath: string): unknown {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function fileLockTimeoutError(params: {
  cause: unknown;
  lockPath: string;
  startedAt: number;
  timeoutMs?: number;
  phase: string;
  holder?: ReturnType<typeof inspectFileLockHolder>;
}) {
  const { cause, lockPath, timeoutMs, phase } = params;
  const holder = params.holder ?? inspectFileLockHolder(readFileLockHolder(lockPath));
  const waitedMs = Math.max(0, Math.round(performance.now() - params.startedAt));
  return Object.assign(
    new Error(
      `file_lock_timeout: file lock timeout for ${lockPath}; waited ${waitedMs} ms (timeout ${timeoutMs ?? "retry budget"}${timeoutMs === undefined ? "" : " ms"}); holder pid=${holder.pid ?? "unknown"} starttime=${holder.starttime ?? "unknown"} thread=${holder.threadId ?? "unknown"} alive=${holder.alive ?? "unknown"} command=${holder.command ?? "unknown"} phase=${holder.phase ?? "unknown"}; waiting phase=${phase}. Wait for the holder to finish, then retry.`,
      { cause },
    ),
    { code: "file_lock_timeout", lockPath, timeoutMs, waitedMs, holder, phase },
  );
}
