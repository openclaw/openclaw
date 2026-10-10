// Configures SQLite WAL and related pragmas for local stores.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { GatewayScheduler } from "./gateway-scheduler.js";
import {
  normalizeSqliteNonNegativeInteger,
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
} from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import {
  createSqliteWalCheckpoint,
  type SqliteWalCheckpointMode,
  type SqliteWalCheckpointOptions,
  type SqliteWalHealth,
} from "./sqlite-wal-checkpoint.js";
import { resolvePathJournalPolicy } from "./sqlite-wal-filesystem.js";
import {
  reclaimSqliteWalFreePages,
  type SqliteWalReclamationOptions,
  type SqliteWalReclamationResult,
} from "./sqlite-wal-reclamation.js";
import {
  detectSqliteWalSplitBrain,
  terminateForSqliteWalSplitBrain,
  type SqliteWalSplitBrainEvent,
} from "./sqlite-wal-split-brain.js";
import {
  cancelSqliteWalWriteAdmission,
  createSqliteWalMaintenanceScheduler,
  type SqliteWalPeriodicRequest,
  type SqliteWalPeriodicResult,
} from "./sqlite-wal-write-admission.js";

export type { SqliteWalHealth } from "./sqlite-wal-checkpoint.js";
export type { SqliteWalReclamationResult } from "./sqlite-wal-reclamation.js";

// WAL maintenance configures SQLite write-ahead logging and schedules bounded
// checkpoints so state databases do not accumulate unbounded WAL files.
// Inline automatic checkpoints run on the committing connection, and while a
// reader keeps the log from resetting every later commit above this threshold
// retries one and syncs the database file. Worker-maintained writers disable it
// when they register their owner and skip checkpoint-only ticks; worker
// connections tick inline, so this threshold only bounds an unmaintained writer.
const DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES = 16_384;
const DEFAULT_SQLITE_WAL_CHECKPOINT_TICK_MS = 10 * 1000;
const DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;
// SQLite applies this ceiling when a fully checkpointed WAL resets on the next
// commit. It matches the inline autocheckpoint threshold so only pathological
// high-water marks pay the truncation cost.
const DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const JOURNAL_MODE_RETRY_INTERVAL_MS = 10;
const JOURNAL_MODE_RETRY_SLEEP = new Int32Array(new SharedArrayBuffer(4));

const log = createSubsystemLogger("infra/sqlite-wal");
const maintenanceScheduler = new GatewayScheduler();
let nextMaintenanceId = 0;

// Gateway bootstrap loads the database owner before admitting turns. Long-lived
// maintenance timers must not retain the context of a turn that opens a database.
export const runInSqliteMaintenanceContext = AsyncLocalStorage.snapshot();

export type SqliteWalMaintenance = {
  /** Last maintenance observation; reading it never checkpoints or probes storage. */
  readonly health?: SqliteWalHealth;
  checkpoint: () => boolean;
  maintainPeriodic?: (
    request: SqliteWalPeriodicRequest,
    admit?: (stage: "transaction" | "commit") => void,
    maintain?: () => void,
  ) => SqliteWalPeriodicResult;
  reclaimFreePages: (options?: SqliteWalReclamationOptions) => SqliteWalReclamationResult;
  /** Inspect this retained WAL connection, independently of checkpoint completion elsewhere. */
  inspectIdle?: () => "healthy" | "retire";
  /** Retire timer admission and join accepted maintenance before closing its database. */
  stop: () => Promise<void>;
  /** Final checkpoint; synchronous exit cleanup cancels work without joining it. */
  close: (options?: { checkpointMode?: SqliteWalCheckpointMode }) => boolean;
};

/** Options controlling WAL autocheckpoint and periodic checkpoint behavior. */
export type SqliteWalMaintenanceOptions = SqliteWalCheckpointOptions & {
  autoCheckpointPages?: number;
  busyTimeoutMs?: number;
  checkpointIntervalMs?: number;
  checkpointMode?: SqliteWalCheckpointMode;
  /** Owner-held synchronous exclusion around maintenance writes, including periodic vacuum. */
  runMaintenance?: (operation: () => boolean) => boolean;
};

export type SqliteConnectionPragmaOptions = SqliteWalMaintenanceOptions & {
  foreignKeys?: boolean;
  synchronous?: "NORMAL";
};

/** Restrict inspection connections without changing journal or persistence policy. */
export function configureSqliteReadOnlyPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
}

// auto_vacuum only takes effect when set before the first page is written.
// Existing databases require an offline VACUUM owned by doctor/maintenance.
function enableIncrementalAutoVacuumForFreshDatabase(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA page_count").get() as { page_count?: unknown } | undefined;
  if (row?.page_count === 0) {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  }
}

/**
 * Configure lock retry before inspecting or mutating a fresh database header.
 * Concurrent first opens can otherwise fail before schema transactions begin.
 */
export function configureSqlitePreSchemaPragmas(
  db: DatabaseSync,
  options: Pick<SqliteConnectionPragmaOptions, "busyTimeoutMs"> = {},
): void {
  if (options.busyTimeoutMs !== undefined) {
    setSqliteBusyTimeout(db, options.busyTimeoutMs);
  }
  enableIncrementalAutoVacuumForFreshDatabase(db);
}

function readJournalModeResult(row: unknown): string | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const record = row as Record<string, unknown>;
  const value = record.journal_mode ?? Object.values(record)[0];
  return typeof value === "string" ? value.toLowerCase() : null;
}

function hasInMemoryMainDatabase(db: DatabaseSync): boolean {
  const rows = db.prepare("PRAGMA database_list;").all() as Array<{
    file?: unknown;
    name?: unknown;
  }>;
  const main = rows.find((row) => row.name === "main");
  return main?.file === "";
}

function requireRollbackJournalMode(db: DatabaseSync, options: SqliteWalMaintenanceOptions): void {
  const row = db.prepare("PRAGMA journal_mode = DELETE;").get();
  const journalMode = readJournalModeResult(row);
  if (journalMode !== "delete") {
    const label = options.databaseLabel ?? "sqlite database";
    const location = options.databasePath ? ` at ${options.databasePath}` : "";
    const actual = journalMode ?? "unknown";
    throw new Error(
      `${label}${location} is on a network-backed volume but SQLite kept journal_mode=${actual}; refusing to continue with WAL on network storage.`,
    );
  }
}

function enableWalJournalMode(
  db: DatabaseSync,
  retryTimeoutMs: number,
  options: SqliteWalMaintenanceOptions,
): boolean {
  const deadline = performance.now() + retryTimeoutMs;
  let restoreBusyTimeout = false;
  try {
    while (true) {
      try {
        db.exec("PRAGMA journal_mode = WAL;");
        const journalMode = readJournalModeResult(db.prepare("PRAGMA journal_mode;").get());
        if (journalMode === "wal") {
          return true;
        }
        // SQLite's in-memory databases cannot use WAL and correctly retain
        // journal_mode=memory. They have no sidecars or checkpoint work.
        if (journalMode === "memory" && hasInMemoryMainDatabase(db)) {
          return false;
        }
        const label = options.databaseLabel ?? "sqlite database";
        const location = options.databasePath ? ` at ${options.databasePath}` : "";
        throw new Error(
          `${label}${location} could not enable WAL; SQLite kept journal_mode=${journalMode ?? "unknown"}.`,
        );
      } catch (error) {
        const remainingMs = Math.max(0, deadline - performance.now());
        if (!isSqliteLockError(error) || remainingMs <= 0) {
          throw error;
        }
        if (!restoreBusyTimeout) {
          // A busy handler can be bypassed to avoid deadlock. Disable it after
          // the first BUSY so explicit retries cannot overrun this deadline.
          setSqliteBusyTimeout(db, 0);
          restoreBusyTimeout = true;
        }
        Atomics.wait(
          JOURNAL_MODE_RETRY_SLEEP,
          0,
          0,
          Math.min(JOURNAL_MODE_RETRY_INTERVAL_MS, remainingMs),
        );
      }
    }
  } finally {
    if (restoreBusyTimeout) {
      setSqliteBusyTimeout(db, retryTimeoutMs);
    }
  }
}

function enableMacosCheckpointFullfsync(db: DatabaseSync): void {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    db.exec("PRAGMA checkpoint_fullfsync = 1;");
  } catch {
    // Older SQLite builds may ignore or reject platform-specific pragmas. WAL
    // setup should still proceed because this is a durability upgrade, not a
    // prerequisite for opening the store.
  }
}

function refuseUnsupportedFilesystem(options: SqliteWalMaintenanceOptions): never {
  const label = options.databaseLabel ?? "sqlite database";
  const location = options.databasePath ? ` at ${options.databasePath}` : "";
  throw new Error(
    `${label}${location} is on SSHFS, which cannot safely coordinate SQLite writes across mounts; refusing to open the database.`,
  );
}

/** Configure safe journaling pragmas and return a handle for checkpoint/close maintenance. */
export function configureSqliteWalMaintenance(
  db: DatabaseSync,
  options: SqliteWalMaintenanceOptions = {},
): SqliteWalMaintenance {
  const busyTimeoutMs = options.busyTimeoutMs ?? 0;
  if (options.busyTimeoutMs !== undefined) {
    setSqliteBusyTimeout(db, options.busyTimeoutMs);
  }
  const autoCheckpointPages = normalizeSqliteNonNegativeInteger(
    options.autoCheckpointPages ?? DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
    "autoCheckpointPages",
  );
  const checkpointIntervalMs = normalizeSqliteNonNegativeInteger(
    options.checkpointIntervalMs ?? DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS,
    "checkpointIntervalMs",
  );
  const timerIntervalMs = Math.min(checkpointIntervalMs, MAX_TIMER_TIMEOUT_MS);
  // Checkpoint-only ticks keep commits off the checkpoint between periodic passes.
  const checkpointTickMs =
    checkpointIntervalMs > DEFAULT_SQLITE_WAL_CHECKPOINT_TICK_MS
      ? DEFAULT_SQLITE_WAL_CHECKPOINT_TICK_MS
      : 0;
  const checkpointMode = options.checkpointMode ?? "TRUNCATE";
  const periodicCheckpointMode = options.checkpointMode ?? "PASSIVE";
  const journalPolicy = options.databasePath
    ? resolvePathJournalPolicy(options.databasePath)
    : "wal";
  if (journalPolicy === "unsupported") {
    refuseUnsupportedFilesystem(options);
  }
  if (journalPolicy === "rollback") {
    requireRollbackJournalMode(db, options);
  }
  if (journalPolicy === "rollback" || !enableWalJournalMode(db, busyTimeoutMs, options)) {
    return {
      checkpoint: () => true,
      reclaimFreePages: (reclaimOptions = {}) =>
        reclaimSqliteWalFreePages(db, () => true, reclaimOptions),
      stop: async () => {},
      close: () => true,
    };
  }
  enableMacosCheckpointFullfsync(db);
  db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPages};`);
  db.exec(`PRAGMA journal_size_limit = ${DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES};`);
  const tripwireDatabasePath =
    process.platform === "linux" && options.databasePath && fs.existsSync(options.databasePath)
      ? fs.realpathSync.native(options.databasePath)
      : undefined;
  let invalidated = false;
  let splitBrainDetectionEnabled = Boolean(tripwireDatabasePath);
  const checkpointOwner = createSqliteWalCheckpoint(
    db,
    options,
    DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES,
  );
  const runCheckpoint = checkpointOwner.checkpoint;

  const runMaintenance = (operation: () => boolean): boolean => {
    if (invalidated) {
      return false;
    }
    try {
      return options.runMaintenance ? options.runMaintenance(operation) : operation();
    } catch (error) {
      checkpointOwner.recordError(error);
      return false;
    }
  };
  const checkpoint = (): boolean => runMaintenance(() => runCheckpoint(checkpointMode));
  const reclaimFreePages = (
    reclaimOptions: SqliteWalReclamationOptions = {},
  ): SqliteWalReclamationResult => {
    let result: SqliteWalReclamationResult | undefined;
    let failure: { error: unknown } | undefined;
    runMaintenance(() => {
      try {
        result = reclaimSqliteWalFreePages(db, runCheckpoint, reclaimOptions);
        return result.checkpointCompleted;
      } catch (error) {
        failure = { error };
        throw error;
      }
    });
    if (failure) {
      throw failure.error;
    }
    if (!result) {
      throw new Error("SQLite page reclamation owner is unavailable");
    }
    return { ...result, checkpoint: checkpointOwner.snapshot };
  };

  const scope = maintenanceScheduler.scope();
  const maintenanceId = `sqlite-wal:${++nextMaintenanceId}`;
  // The periodic pass sets the vacuum budget; the next run consumes it, ticks add none.
  let nextPageBudget = 0;
  const maintainPeriodic = (
    request: SqliteWalPeriodicRequest,
    admit?: (stage: "transaction" | "commit") => void,
    maintain?: () => void,
  ): SqliteWalPeriodicResult => {
    if (invalidated) {
      return { reclaimedPages: 0 };
    }
    if (request.checkpoint) {
      checkpointOwner.adopt(request.checkpoint);
    }
    let reclaimedPages = 0;
    const quiet = request.maxPages === 0;
    const runTickCheckpoint = (mode: SqliteWalCheckpointMode) =>
      checkpointOwner.checkpoint(mode, { quiet });
    runMaintenance(() => {
      let checkpointed: boolean;
      if (quiet && request.checkpointMode === "PASSIVE") {
        // SQLite never calls the busy handler for PASSIVE; this pass cannot vacuum.
        admit?.("transaction");
        checkpointed = runTickCheckpoint("PASSIVE");
      } else {
        const reclaimed = reclaimSqliteWalFreePages(db, runTickCheckpoint, {
          checkpointMode: request.checkpointMode,
          maxPages: request.maxPages,
          beforeMutation: () => admit?.("transaction"),
          onCommit: () => admit?.("commit"),
        });
        checkpointed = reclaimed.checkpointCompleted;
        if (
          checkpointed &&
          reclaimed.freePagesBefore !== null &&
          reclaimed.remainingFreePages !== null
        ) {
          reclaimedPages = Math.min(
            reclaimed.vacuumPagesRequested,
            reclaimed.freePagesBefore - reclaimed.remainingFreePages,
          );
        }
      }
      if (
        checkpointed &&
        request.checkpointMode === "PASSIVE" &&
        (checkpointOwner.health?.walBytes ?? 0) > DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES
      ) {
        // A completed PASSIVE checkpoint need not recycle its high-water file
        // until another commit. Try once without waiting for readers or writers.
        admit?.("transaction");
        runWithSqliteBusyTimeout(db, 0, () => runTickCheckpoint("TRUNCATE"));
      }
      if (checkpointed && request.maxPages > 0 && !request.continuation) {
        try {
          maintain?.();
        } catch (error) {
          if (!isSqliteLockError(error)) {
            throw error;
          }
        }
      }
      return checkpointed;
    });
    return { reclaimedPages, checkpoint: checkpointOwner.snapshot };
  };
  const maintain = createSqliteWalMaintenanceScheduler(
    db,
    maintainPeriodic,
    (maxPages) =>
      timerIntervalMs > 0 && !scope.signal.aborted && !invalidated
        ? { maxPages, checkpointMode: periodicCheckpointMode, checkpoint: checkpointOwner.snapshot }
        : undefined,
    checkpointOwner.adopt,
    (error) => checkpointOwner.recordError(error),
    () => {
      const budget = nextPageBudget;
      nextPageBudget = 0;
      return budget;
    },
  );
  const schedule = (phase: string, intervalMs: number, run: () => Promise<void>) =>
    runInSqliteMaintenanceContext(() =>
      scope.schedule({
        id: `${maintenanceId}:${phase}`,
        delayMs: intervalMs,
        everyMs: intervalMs,
        run,
      }),
    );
  if (timerIntervalMs > 0) {
    schedule("periodic", timerIntervalMs, () => {
      // Inspect the published handle before identity admission or synchronous cleanup.
      if (tripwireDatabasePath && splitBrainDetectionEnabled) {
        let splitBrain: SqliteWalSplitBrainEvent | undefined;
        try {
          splitBrain = detectSqliteWalSplitBrain(tripwireDatabasePath);
        } catch (error) {
          splitBrainDetectionEnabled = false;
          log.warn("SQLite WAL split-brain detection disabled", {
            databaseLabel: options.databaseLabel,
            databasePath: tripwireDatabasePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (splitBrain) {
          invalidated = true;
          scope.beginClose();
          terminateForSqliteWalSplitBrain(splitBrain, options.databaseLabel);
        }
      }
      nextPageBudget = 512;
      return maintain();
    });
  }
  if (checkpointTickMs > 0) {
    schedule("tick", checkpointTickMs, maintain);
  }

  const beginClose = () => {
    runInSqliteMaintenanceContext(() => scope.beginClose());
    return cancelSqliteWalWriteAdmission(db);
  };

  return {
    get health() {
      return checkpointOwner.health;
    },
    checkpoint,
    maintainPeriodic,
    reclaimFreePages,
    inspectIdle: () => (runMaintenance(checkpointOwner.inspectIdle) ? "healthy" : "retire"),
    stop: async () => {
      try {
        await beginClose();
      } finally {
        await runInSqliteMaintenanceContext(() => scope.stop());
      }
    },
    close: (closeOptions) => {
      void beginClose();
      if (invalidated) {
        return false;
      }
      // Cache eviction passes PASSIVE: a TRUNCATE close-checkpoint waits on
      // readers and has starved the event loop for seconds under fleet churn.
      // Orderly dispose/delete keeps TRUNCATE so sidecars are flushed for unlink.
      return runMaintenance(() => runCheckpoint(closeOptions?.checkpointMode ?? checkpointMode));
    },
  };
}

type SqliteExitRegistration = { close: () => void; fired: boolean };
type SqliteExitGroup = {
  pending: Set<SqliteExitRegistration>;
  dispatch: () => void;
};
let lastSqliteExitGroup: SqliteExitGroup | undefined;

function detachEmptySqliteExitGroup(group: SqliteExitGroup): void {
  if (group.pending.size > 0) {
    return;
  }
  if (lastSqliteExitGroup === group) {
    lastSqliteExitGroup = undefined;
  }
  process.removeListener("exit", group.dispatch);
}

/**
 * Register a best-effort exit-time close for a SQLite handle cache. Returns an
 * unregister callback the cache's orderly close path must invoke, so tests and
 * runtime shutdowns do not accumulate listeners on shared worker processes.
 */
export function registerSqliteCacheExitClose(closeAll: () => void): () => void {
  const registration = { close: closeAll, fired: false };
  let group = lastSqliteExitGroup;
  // Preserve intervening owners, such as capture finalization before database close.
  if (!group || process.listeners("exit").at(-1) !== group.dispatch) {
    const pending = new Set([registration]);
    const created: SqliteExitGroup = {
      pending,
      dispatch: () => {
        // Snapshot this batch before callbacks; disposal cannot skip an admitted close.
        const snapshot = [...pending];
        for (const entry of snapshot) {
          if (entry.fired) {
            continue;
          }
          entry.fired = true;
          pending.delete(entry);
          detachEmptySqliteExitGroup(created);
          try {
            entry.close();
          } catch {
            // Exit-time close is best-effort; unclean exits rely on WAL recovery.
          }
        }
      },
    };
    // Keep the dispatcher until the last callback starts, including nested emissions.
    process.on("exit", created.dispatch);
    lastSqliteExitGroup = group = created;
  } else {
    group.pending.add(registration);
  }
  const owner = group;
  return () => {
    owner.pending.delete(registration);
    detachEmptySqliteExitGroup(owner);
  };
}

/** Configure per-connection SQLite pragmas in the safe lock-retry/WAL order. */
export function configureSqliteConnectionPragmas(
  db: DatabaseSync,
  options: SqliteConnectionPragmaOptions = {},
): SqliteWalMaintenance {
  const { foreignKeys, synchronous, ...walOptions } = options;
  const maintenance = configureSqliteWalMaintenance(db, walOptions);
  try {
    if (synchronous) {
      db.exec(`PRAGMA synchronous = ${synchronous};`);
    }
    if (foreignKeys) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
    return maintenance;
  } catch (error) {
    // The caller cannot dispose maintenance until this function returns it.
    try {
      maintenance.close();
    } catch (closeError) {
      throw createSqliteLifecycleAggregateError(
        [error, closeError],
        "SQLite connection pragma configuration and WAL maintenance cleanup both failed.",
        error,
      );
    }
    throw error;
  }
}
