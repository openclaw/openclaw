import fs from "node:fs";
import { getChildLogger } from "../logging/logger.js";
import { hasErrnoCode } from "./errno.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";

export const MAX_SNAPSHOT_ATTEMPTS = 10;

const SNAPSHOT_QUIESCENCE_SAMPLE_MS = 20;
const SNAPSHOT_QUIESCENCE_STABLE_MS = 40;
const SNAPSHOT_QUIESCENCE_DEADLINE_MS = 160;
const SNAPSHOT_RETRY_BASE_MS = 10;
const SNAPSHOT_RETRY_MAX_MS = 80;

type SourceSizeSample = {
  mainBytes: number;
  mainMtimeMs: number;
  walBytes: number;
  walMtimeMs: number;
};

export type SnapshotAdmission = {
  sample: SourceSizeSample;
  stabilized: boolean;
  waitMs: number;
};

type SnapshotOperation = "online-backup" | "raw-copy";
type SnapshotOutcome = "changed" | "error" | "success";

function sourceFileSample(pathname: string): { bytes: number; mtimeMs: number } {
  try {
    const stat = fs.statSync(pathname);
    return stat.isFile() ? { bytes: stat.size, mtimeMs: stat.mtimeMs } : { bytes: 0, mtimeMs: 0 };
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return { bytes: 0, mtimeMs: 0 };
    }
    throw error;
  }
}

function sourceSizeSample(pathname: string): SourceSizeSample {
  const main = sourceFileSample(pathname);
  const wal = sourceFileSample(`${pathname}-wal`);
  return {
    mainBytes: main.bytes,
    mainMtimeMs: main.mtimeMs,
    walBytes: wal.bytes,
    walMtimeMs: wal.mtimeMs,
  };
}

function sameSourceSizeSample(left: SourceSizeSample, right: SourceSizeSample): boolean {
  return (
    left.mainBytes === right.mainBytes &&
    left.mainMtimeMs === right.mainMtimeMs &&
    left.walBytes === right.walBytes &&
    left.walMtimeMs === right.walMtimeMs
  );
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

export async function waitForSnapshotQuiescence(
  pathname: string,
  signal?: AbortSignal,
): Promise<SnapshotAdmission> {
  const started = performance.now();
  const deadline = started + SNAPSHOT_QUIESCENCE_DEADLINE_MS;
  let stableSince = started;
  let previous = sourceSizeSample(pathname);
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    await sleepForSnapshot(SNAPSHOT_QUIESCENCE_SAMPLE_MS, signal);
    const now = performance.now();
    const current = sourceSizeSample(pathname);
    if (!sameSourceSizeSample(previous, current)) {
      previous = current;
      stableSince = now;
    } else if (now - stableSince >= SNAPSHOT_QUIESCENCE_STABLE_MS) {
      return { sample: current, stabilized: true, waitMs: Math.max(0, now - started) };
    }
  }
  signal?.throwIfAborted();
  return {
    sample: sourceSizeSample(pathname),
    stabilized: false,
    waitMs: Math.max(0, performance.now() - started),
  };
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
  admission: SnapshotAdmission,
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
          sourceMainBytes: admission.sample.mainBytes,
          sourceWalBytes: admission.sample.walBytes,
          stabilized: admission.stabilized,
          waitMs: admission.waitMs,
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
