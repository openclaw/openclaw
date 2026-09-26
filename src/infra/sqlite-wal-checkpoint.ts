import fs from "node:fs";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { normalizeSqliteNumber, readFiniteSqliteNumber } from "./sqlite-number.js";
import {
  readSqliteReaderDiagnosticsForPath,
  sqliteReaderDatabasePathKey,
  type SqliteReaderDiagnostic,
  type SqliteReaderDiagnostics,
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
  readerDiagnostics?: Array<Omit<SqliteReaderDiagnostics, "activeReaders">>;
};

export type SqliteWalCheckpointSnapshot = { health: SqliteWalHealth; observedAtNs: bigint };
export type SqliteWalCheckpointObservation = SqliteWalCheckpointSnapshot & { databasePath: string };
const checkpointListeners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWalCheckpointListeners"),
  () => new Set<(observation: SqliteWalCheckpointObservation) => void>(),
);

/** Maintenance consumers receive observations after the checkpoint owner records its outcome. */
export function onSqliteWalCheckpoint(
  listener: (observation: SqliteWalCheckpointObservation) => void,
): () => void {
  checkpointListeners.add(listener);
  return () => {
    checkpointListeners.delete(listener);
  };
}

/** A relayed worker result adds host observations without claiming visibility into other threads. */
function observeSqliteWalCheckpointHealth(
  databasePath: string,
  health: SqliteWalHealth,
): SqliteWalHealth {
  const {
    activeReaders: previousReaders,
    readerDiagnostics: previousDiagnostics,
    ...observation
  } = health;
  if (health.state === "complete") {
    return observation;
  }
  const { activeReaders, ...local } = readSqliteReaderDiagnosticsForPath(databasePath);
  return {
    ...observation,
    activeReaders: [
      ...(previousReaders ?? []).filter((reader) => reader.threadId !== local.threadId),
      ...activeReaders,
    ]
      .toSorted((left, right) => right.ageMs - left.ageMs)
      .slice(0, 8),
    readerDiagnostics: [
      ...(previousDiagnostics ?? []).filter((diagnostic) => diagnostic.threadId !== local.threadId),
      local,
    ].slice(-8),
  };
}

function notifyCheckpoint(databasePath: string, snapshot: SqliteWalCheckpointSnapshot): void {
  for (const listener of checkpointListeners) {
    try {
      listener({
        databasePath: sqliteReaderDatabasePathKey(databasePath),
        health: structuredClone(snapshot.health),
        observedAtNs: snapshot.observedAtNs,
      });
    } catch {
      // Diagnostic consumers cannot change the native checkpoint's outcome.
    }
  }
}

/** Worker result transport relays the recorded fact and returns its enriched diagnostic snapshot. */
export function publishSqliteWalCheckpointObservation(
  databasePath: string,
  snapshot: SqliteWalCheckpointSnapshot,
): SqliteWalCheckpointSnapshot {
  const observed = {
    health: observeSqliteWalCheckpointHealth(databasePath, snapshot.health),
    observedAtNs: snapshot.observedAtNs,
  };
  notifyCheckpoint(databasePath, observed);
  return observed;
}

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

function checkpoint(database: DatabaseSync, mode: SqliteWalCheckpointMode) {
  return database.prepare(`PRAGMA wal_checkpoint(${mode});`).get(); // sqlite-allow-raw -- WAL checkpoint primitive under caller-owned admission.
}

/** Offline maintenance must stop before compaction or recovery if truncation remains busy. */
export function truncateSqliteWal(database: DatabaseSync, sqlitePath: string): void {
  const row = checkpoint(database, "TRUNCATE");
  const busy = readFiniteSqliteNumber(row?.busy ?? (row ? Object.values(row)[0] : undefined));
  if (busy === undefined) {
    throw new Error(`SQLite checkpoint returned an invalid result for ${sqlitePath}.`);
  }
  if (busy !== 0) {
    throw new Error(`SQLite checkpoint remained busy for ${sqlitePath}. Stop OpenClaw and retry.`);
  }
}

/** The maintenance lifecycle owns this checkpoint result and its last observation. */
export function createSqliteWalCheckpoint(
  database: DatabaseSync,
  options: SqliteWalCheckpointOptions,
  journalSizeLimitBytes: number,
) {
  let snapshot: SqliteWalCheckpointSnapshot | undefined;

  const checkpointObservation = (): SqliteWalHealth => ({
    state: "error",
    observedAtMs: Date.now(),
    walBytes: null,
    databaseBytes: null,
    logFrames: null,
    checkpointedFrames: null,
    lastCompletedAtMs: snapshot?.health.lastCompletedAtMs ?? null,
    consecutiveBlocked: 0,
    warning: true,
  });

  const recordCheckpointError = (error: unknown, observation = checkpointObservation()): void => {
    const failed: SqliteWalHealth = {
      ...observation,
      observedAtMs: Date.now(),
      state: "error",
      consecutiveBlocked: 0,
      warning: true,
      error: formatErrorMessage(error),
    };
    snapshot = {
      observedAtNs: process.hrtime.bigint(),
      health: options.databasePath
        ? observeSqliteWalCheckpointHealth(options.databasePath, failed)
        : failed,
    };
    if (options.databasePath) {
      notifyCheckpoint(options.databasePath, snapshot);
    }
    options.onCheckpointError?.(error);
  };

  const recordCheckpoint = (
    mode: SqliteWalCheckpointMode,
    row: Record<string, SQLOutputValue> | undefined,
  ): boolean => {
    // Worker relays keep this same-process ordering fact even if the wall clock steps backward.
    const observedAtNs = process.hrtime.bigint();
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
        observation.consecutiveBlocked = (snapshot?.health.consecutiveBlocked ?? 0) + 1;
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
      snapshot = {
        observedAtNs,
        health: options.databasePath
          ? observeSqliteWalCheckpointHealth(options.databasePath, observation)
          : observation,
      };
      if (options.databasePath) {
        notifyCheckpoint(options.databasePath, snapshot);
      }
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
    adopt(this: void, received: SqliteWalCheckpointSnapshot): void {
      if (snapshot && snapshot.observedAtNs >= received.observedAtNs) {
        return;
      }
      snapshot = structuredClone(received);
      if (options.databasePath) {
        snapshot.health = observeSqliteWalCheckpointHealth(options.databasePath, snapshot.health);
        notifyCheckpoint(options.databasePath, snapshot);
      }
    },
    checkpoint(this: void, mode: SqliteWalCheckpointMode): boolean {
      try {
        return recordCheckpoint(mode, checkpoint(database, mode));
      } catch (error) {
        recordCheckpointError(error);
        return false;
      }
    },
    recordError: recordCheckpointError,
    inspectIdle(this: void): boolean {
      const { busy, logFrames, checkpointedFrames } = readCheckpointResult(
        checkpoint(database, "PASSIVE"),
      );
      // An incomplete PASSIVE checkpoint can belong to another connection's reader.
      // A local native reader instead refuses the checkpoint; non-WAL results are negative.
      return (
        busy === 0 && logFrames >= 0 && checkpointedFrames >= 0 && checkpointedFrames <= logFrames
      );
    },
    get health() {
      return snapshot ? structuredClone(snapshot.health) : undefined;
    },
    get snapshot() {
      return snapshot ? structuredClone(snapshot) : undefined;
    },
  };
}
