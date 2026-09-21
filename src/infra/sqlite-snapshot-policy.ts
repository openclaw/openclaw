import fs from "node:fs";
import { getChildLogger } from "../logging/logger.js";
import { hasErrnoCode } from "./errno.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";

export const MAX_SNAPSHOT_ATTEMPTS = 10;

const SNAPSHOT_RETRY_BASE_MS = 10;
const SNAPSHOT_RETRY_MAX_MS = 80;

type SnapshotOperation = "online-backup" | "raw-copy";
type SnapshotOutcome = "changed" | "error" | "success";

function sourceFileSize(pathname: string): number {
  try {
    const stat = fs.statSync(pathname);
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("SQLite snapshot aborted");
}

async function sleepForSnapshot(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const abort = () => finish(signal ? abortReason(signal) : undefined);
    function finish(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
}

function snapshotRetryDelayMs(attempt: number): number {
  if (attempt + 1 >= MAX_SNAPSHOT_ATTEMPTS) {
    return 0;
  }
  return Math.min(SNAPSHOT_RETRY_MAX_MS, SNAPSHOT_RETRY_BASE_MS * 2 ** attempt);
}

export function waitForSnapshotRetrySync(attempt: number): void {
  const delayMs = snapshotRetryDelayMs(attempt);
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}

export async function waitForSnapshotRetry(attempt: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const delayMs = snapshotRetryDelayMs(attempt);
  if (delayMs > 0) {
    await sleepForSnapshot(delayMs, signal);
  }
}

export function createSnapshotAttemptReporter(
  pathname: string,
  attempt: number,
  started: number,
): (
  operation: SnapshotOperation,
  outcome: SnapshotOutcome,
  prepared?: PreparedSqliteReadOnlyLocation,
  error?: unknown,
) => void {
  return (operation, outcome, prepared, error) => {
    try {
      getChildLogger({ subsystem: "infra/sqlite-snapshot" }).debug(
        {
          attempt: attempt + 1,
          copiedBytes: prepared ? fs.statSync(prepared.location).size : 0,
          durationMs: Math.max(0, performance.now() - started),
          operation,
          outcome,
          sourceMainBytes: sourceFileSize(pathname),
          sourceWalBytes: sourceFileSize(`${pathname}-wal`),
          owner: "path-reader",
          errorCode:
            error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
        },
        "SQLite snapshot operation completed.",
      );
    } catch {
      // Snapshot diagnostics must not replace the operation result.
    }
  };
}
