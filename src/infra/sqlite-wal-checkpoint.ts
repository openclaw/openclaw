import fs from "node:fs";
import type { SQLOutputValue } from "node:sqlite";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { normalizeSqliteNumber } from "./sqlite-number.js";
import {
  readActiveSqliteReadersForPath,
  type SqliteReaderDiagnostic,
} from "./sqlite-reader-lifecycle.js";

export type SqliteWalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

export type SqliteWalCheckpointOptions = {
  databaseLabel?: string;
  databasePath?: string;
  onCheckpointError?: (error: unknown) => void;
};

export type SqliteWalHealth = {
  state: "complete" | "blocked" | "error";
  observedAtMs: number;
  walBytes: number | null;
  databaseBytes: number | null;
  logFrames: number | null;
  checkpointedFrames: number | null;
  lastCompletedAtMs: number | null;
  consecutiveBlocked: number;
  warning: boolean;
  error?: string;
  activeReaders?: SqliteReaderDiagnostic[];
};

function sqliteFileBytes(pathname: string): number {
  try {
    return fs.statSync(pathname).size;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

function readCheckpointResult(row: Record<string, SQLOutputValue> | undefined) {
  const [busy, logFrames, checkpointedFrames] = Object.values(row ?? {}).map((value) =>
    normalizeSqliteNumber(typeof value === "number" || typeof value === "bigint" ? value : null),
  );
  if (busy === undefined || logFrames === undefined || checkpointedFrames === undefined) {
    throw new Error("SQLite returned an invalid WAL checkpoint result");
  }
  return { busy, logFrames, checkpointedFrames };
}

/** The maintenance lifecycle owns this checkpoint result and its last observation. */
export function createSqliteWalCheckpoint(
  options: SqliteWalCheckpointOptions,
  journalSizeLimitBytes: number,
) {
  let health: SqliteWalHealth | undefined;

  const checkpointObservation = (): SqliteWalHealth => ({
    state: "error",
    observedAtMs: Date.now(),
    walBytes: null,
    databaseBytes: null,
    logFrames: null,
    checkpointedFrames: null,
    lastCompletedAtMs: health?.lastCompletedAtMs ?? null,
    consecutiveBlocked: 0,
    warning: true,
  });

  const recordCheckpointError = (error: unknown, observation = checkpointObservation()): void => {
    health = {
      ...observation,
      observedAtMs: Date.now(),
      state: "error",
      consecutiveBlocked: 0,
      warning: true,
      error: formatErrorMessage(error),
    };
    options.onCheckpointError?.(error);
  };

  const recordCheckpoint = (
    mode: SqliteWalCheckpointMode,
    row: Record<string, SQLOutputValue> | undefined,
  ): boolean => {
    const observation = checkpointObservation();
    let busy: boolean;
    let sizeError: unknown;
    try {
      const { busy: busyResult, logFrames, checkpointedFrames } = readCheckpointResult(row);
      busy = busyResult !== 0;
      observation.logFrames = logFrames;
      observation.checkpointedFrames = checkpointedFrames;
      // PASSIVE reports busy=0 even when a reader prevents copying all frames.
      observation.state = busy || checkpointedFrames < logFrames ? "blocked" : "complete";
      if (observation.state === "complete") {
        observation.lastCompletedAtMs = observation.observedAtMs;
      } else {
        observation.consecutiveBlocked = (health?.consecutiveBlocked ?? 0) + 1;
      }
      if (options.databasePath) {
        try {
          observation.databaseBytes = sqliteFileBytes(options.databasePath);
          observation.walBytes = sqliteFileBytes(`${options.databasePath}-wal`);
        } catch (error) {
          // Size diagnostics must not change the native checkpoint's completion result.
          sizeError = error;
          observation.error = formatErrorMessage(error);
        }
      }
      // Allow the existing retained-WAL ceiling or two database images before warning early.
      observation.warning =
        observation.state === "blocked" &&
        (observation.consecutiveBlocked >= 2 ||
          (observation.walBytes !== null &&
            observation.databaseBytes !== null &&
            observation.walBytes > Math.max(2 * observation.databaseBytes, journalSizeLimitBytes)));
      if (observation.state === "blocked") {
        const readers = options.databasePath
          ? readActiveSqliteReadersForPath(options.databasePath)
          : [];
        if (readers.length) {
          observation.activeReaders = readers;
        }
      }
      health = observation;
    } catch (error) {
      recordCheckpointError(error, observation);
      return false;
    }
    if (observation.error !== undefined) {
      options.onCheckpointError?.(sizeError);
    }
    if (busy || observation.warning) {
      const label = options.databaseLabel ?? "sqlite database";
      options.onCheckpointError?.(
        new Error(
          `${label} WAL checkpoint ${mode} ${busy ? "remained busy" : "blocked by a reader"}`,
        ),
      );
    }
    return observation.state === "complete";
  };

  return {
    record: recordCheckpoint,
    recordError: recordCheckpointError,
    inspectIdle(row: Record<string, SQLOutputValue> | undefined): boolean {
      const { busy, logFrames, checkpointedFrames } = readCheckpointResult(row);
      // An incomplete PASSIVE checkpoint can belong to another connection's reader.
      // A local native reader instead refuses the checkpoint; non-WAL results are negative.
      return (
        busy === 0 && logFrames >= 0 && checkpointedFrames >= 0 && checkpointedFrames <= logFrames
      );
    },
    get health() {
      return health
        ? {
            ...health,
            ...(health.activeReaders
              ? { activeReaders: health.activeReaders.map((reader) => Object.assign({}, reader)) }
              : {}),
          }
        : undefined;
    },
  };
}
