import fs from "node:fs";
import { getChildLogger } from "../logging/logger.js";
import { hasErrnoCode } from "./errno.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";

export const MAX_SNAPSHOT_ATTEMPTS = 10;

const SNAPSHOT_RETRY_BASE_MS = 10;
const SNAPSHOT_RETRY_MAX_MS = 80;

type SnapshotOperation = "online-backup" | "raw-copy";
type SnapshotOutcome = "error" | "success";

export function sqliteSnapshotSourceFileSize(pathname: string): number {
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

export function emitSqliteSnapshotTelemetry(
  fields: {
    attempt: number;
    copiedBytes: number;
    durationMs: number;
    operation: SnapshotOperation;
    outcome: SnapshotOutcome;
    owner: string;
    sourceMainBytes: number;
    sourceWalBytes: number;
    waitMs?: number;
  },
  error?: unknown,
): void {
  try {
    getChildLogger({ subsystem: "infra/sqlite-snapshot" }).debug(
      {
        ...fields,
        errorCode:
          error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
      },
      "SQLite snapshot operation completed.",
    );
  } catch {
    // Snapshot diagnostics must not replace the operation result.
  }
}

export function waitForSnapshotRetrySync(attempt: number): void {
  if (attempt + 1 >= MAX_SNAPSHOT_ATTEMPTS) {
    return;
  }
  const delayMs = Math.min(SNAPSHOT_RETRY_MAX_MS, SNAPSHOT_RETRY_BASE_MS * 2 ** attempt);
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}

export function createSnapshotAttemptReporter(
  pathname: string,
): (
  operation: SnapshotOperation,
  outcome: SnapshotOutcome,
  prepared?: PreparedSqliteReadOnlyLocation,
  error?: unknown,
) => void {
  const started = performance.now();
  return (operation, outcome, prepared, error) => {
    try {
      emitSqliteSnapshotTelemetry(
        {
          attempt: 1,
          copiedBytes: prepared ? fs.statSync(prepared.location).size : 0,
          durationMs: Math.max(0, performance.now() - started),
          operation,
          outcome,
          sourceMainBytes: sqliteSnapshotSourceFileSize(pathname),
          sourceWalBytes: sqliteSnapshotSourceFileSize(`${pathname}-wal`),
          owner: "path-reader",
        },
        error,
      );
    } catch {
      // Snapshot diagnostics must not replace the operation result.
    }
  };
}
