// Provides SQLite transaction helpers with nested savepoints.
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainThread, threadId } from "node:worker_threads";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
// The cache-state module keeps this lifecycle edge off the kysely value graph
// so cold control-plane paths using transactions do not load kysely.
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import { PostgresSyncConnection } from "./postgres-sync/connection.js";
import { runPostgresTransactionSync } from "./postgres-sync/transaction.js";
import { assertTransactionUsable as assertPostgresTransactionUsable } from "./sql-connection.js";
import {
  readSqliteBusyTimeout,
  runWithSqliteBusyTimeout,
  shouldReportSqliteLockFailure,
} from "./sqlite-busy-timeout.js";
import {
  isSqliteLockError,
  sqliteErrorCode,
  sqliteExtendedResultCode,
  sqlitePrimaryResultCode,
} from "./sqlite-error-diagnostics.js";
import {
  discardSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import {
  captureSqliteReaderOwner,
  currentSqliteOperationTiming,
} from "./sqlite-reader-lifecycle.js";
import { runSqliteReadOperationSync } from "./sqlite-schema-facts.js";
import type { SqliteWorkerDatabaseContext } from "./sqlite-worker-database-context.js";
import { normalizeDatabasePath } from "./sqlite-worker-identity.js";

const DEFAULT_SLOW_BUSY_WAIT_MS = 1_000;
const DEFAULT_SLOW_TRANSACTION_HOLD_MS = 1_000;

// The same native handle can cross transformed SDK module graphs. Retain the
// first terminal failure even when an inner caller catches it and continues.
const abortedTransactionSymbol = Symbol.for("openclaw.sqliteAbortedTransaction");
type TransactionDatabase = DatabaseSync & {
  [abortedTransactionSymbol]?: { error: unknown };
};

export function assertTransactionUsable(db: TransactionDatabase): void {
  const aborted = db[abortedTransactionSymbol];
  if (aborted) {
    throw aborted.error;
  }
}

const transactionLog = createSubsystemLogger("sqlite/transaction");
const writeAdmissionServices = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWriteAdmissionServices"),
  () => new Map<string, Set<() => void>>(),
);
const writeAdmissionLocations = new WeakMap<DatabaseSync, string | null>();

function writeAdmissionLocation(database: DatabaseSync): string | null {
  const cached = writeAdmissionLocations.get(database);
  if (cached !== undefined) {
    return cached;
  }
  // A native handle's filename is stable; normalize namespace aliases once, without filesystem IO.
  const location = database.location();
  const canonical = location === null ? null : normalizeDatabasePath(location);
  writeAdmissionLocations.set(database, canonical);
  return canonical;
}

/** Keep worker-owned lock holders serviceable across connections and module graphs. */
export async function withSqliteWriteAdmissionService<T>(
  database: DatabaseSync,
  service: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  const location = writeAdmissionLocation(database);
  if (location === null) {
    throw new Error("SQLite write admission service requires a file-backed database");
  }
  const release = retainSqliteWriteAdmissionService([location], service);
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Locations come from the retained native owner; registration grants no write authority. */
export function retainSqliteWriteAdmissionService(
  nativeLocations: readonly string[],
  service: () => void,
): () => void {
  const locations = new Set(nativeLocations.map(normalizeDatabasePath));
  const registrations = [...locations].map((location) => {
    const services = writeAdmissionServices.get(location) ?? new Set<() => void>();
    // Separate reservations remain valid when the same owner retains two operations.
    const retained = () => service();
    services.add(retained);
    writeAdmissionServices.set(location, services);
    return { location, services, retained };
  });
  return () => {
    for (const { location, services, retained } of registrations) {
      services.delete(retained);
      if (services.size === 0 && writeAdmissionServices.get(location) === services) {
        writeAdmissionServices.delete(location);
      }
    }
  };
}

type SqliteBeginAdmissionDiagnostics = {
  nativeAttempts: number;
  nativeMs: number;
  serviceCalls: number;
  serviceMs: number;
};

function execNativeBegin(db: DatabaseSync, diagnostics: SqliteBeginAdmissionDiagnostics): void {
  const startedAt = Date.now();
  diagnostics.nativeAttempts += 1;
  try {
    db.exec("BEGIN IMMEDIATE");
  } finally {
    diagnostics.nativeMs += Date.now() - startedAt;
  }
}

function beginImmediateTransaction(
  db: DatabaseSync,
  diagnostics: SqliteBeginAdmissionDiagnostics,
): void {
  const location = writeAdmissionServices.size > 0 ? writeAdmissionLocation(db) : null;
  const services = location === null ? undefined : writeAdmissionServices.get(location);
  if (!services) {
    execNativeBegin(db, diagnostics);
    return;
  }
  const deadline = performance.now() + readSqliteBusyTimeout(db);
  while (true) {
    try {
      runWithSqliteBusyTimeout(
        db,
        Math.min(25, Math.max(0, Math.ceil(deadline - performance.now()))),
        () => execNativeBegin(db, diagnostics),
      );
      return;
    } catch (error) {
      if (!isSqliteLockError(error) || performance.now() >= deadline) {
        throw error;
      }
      // Only admission repeats. Services retain their own authority and settlement
      // rules; caller mutations and postcommit publication have not started yet.
      for (const service of services) {
        const startedAt = Date.now();
        diagnostics.serviceCalls += 1;
        try {
          service();
        } finally {
          diagnostics.serviceMs += Date.now() - startedAt;
        }
      }
      if (performance.now() >= deadline) {
        throw error;
      }
    }
  }
}

export type SqliteTransactionOptions = {
  /** Already-started BEGIN budget, carried between workers in the same process. */
  beginDeadlineNs?: bigint;
  /** An outer owner handles nonblocking admission failures. */
  beginLockFailureReporting?: "suppress";
  busyTimeoutMs?: number;
  databaseLabel?: string;
  /** Prepared identifiers and counts only; never transcript or session payloads. */
  diagnosticContext?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  logger?: Pick<SubsystemLogger, "warn">;
  operationLabel?: string;
  slowTransactionHoldMs?: number;
  /** Enclose the physical commit in an owner's synchronous authority guard. */
  withCommit?: (commit: () => void) => void;
};

type SqliteTransactionStep = "begin" | "commit";
type SqliteTransactionMode = "deferred" | "immediate";

function assertSyncTransactionResult(value: unknown): void {
  if (isPromiseLike(value)) {
    throw new Error(
      "SQLite write transactions must be synchronous; Promise returns are not supported.",
    );
  }
}

function slowBusyWaitThresholdMs(options: SqliteTransactionOptions | undefined): number {
  if (options?.busyTimeoutMs === undefined || options.busyTimeoutMs <= 0) {
    return DEFAULT_SLOW_BUSY_WAIT_MS;
  }
  return Math.min(DEFAULT_SLOW_BUSY_WAIT_MS, options.busyTimeoutMs);
}

function transactionDiagnosticLabels(
  db: DatabaseSync | undefined,
  options:
    | Pick<SqliteTransactionOptions, "databaseLabel" | "operationLabel" | "diagnosticContext">
    | undefined,
) {
  let database = options?.databaseLabel;
  if (!database) {
    try {
      database = db ? (db.location() ?? ":memory:") : "unavailable";
    } catch {
      // Failed rollback may have retired the native connection before reporting its hold.
      database = "unavailable";
    }
  }
  return {
    database,
    operation: options?.operationLabel || captureSqliteReaderOwner()?.operation || "unlabeled",
    ...(options?.diagnosticContext ? { context: { ...options.diagnosticContext } } : {}),
  };
}

function logSlowTransactionHold(params: {
  db: DatabaseSync;
  elapsedMs: number;
  mode: SqliteTransactionMode;
  options?: SqliteTransactionOptions;
  prepareMs?: number;
  beginMs: number;
  hostAdmissionWaitMs: number;
  commitMs: number;
}): void {
  if (
    params.elapsedMs < (params.options?.slowTransactionHoldMs ?? DEFAULT_SLOW_TRANSACTION_HOLD_MS)
  ) {
    return;
  }
  (params.options?.logger ?? transactionLog).warn("slow SQLite transaction hold", {
    async: false,
    ...transactionDiagnosticLabels(params.db, params.options),
    elapsedMs: params.elapsedMs,
    phases: {
      prepareMs: params.prepareMs,
      beginMs: params.beginMs,
      sqlMs: Math.max(0, params.elapsedMs - params.hostAdmissionWaitMs - params.commitMs),
      hostAdmissionWaitMs: params.hostAdmissionWaitMs,
      commitMs: params.commitMs,
    },
    isMainThread,
    mode: params.mode,
    pid: process.pid,
    threadId,
    thresholdMs: params.options?.slowTransactionHoldMs ?? DEFAULT_SLOW_TRANSACTION_HOLD_MS,
  });
}

function logTransactionStep(
  params: {
    beginAdmission?: SqliteBeginAdmissionDiagnostics;
    db: DatabaseSync;
    elapsedMs: number;
    options?: SqliteTransactionOptions;
    step: SqliteTransactionStep;
  },
  failure?: { error: unknown },
): void {
  if (!failure && params.elapsedMs < slowBusyWaitThresholdMs(params.options)) {
    return;
  }
  const sqliteErrcode = failure ? sqliteExtendedResultCode(failure.error) : undefined;
  const sqlitePrimaryCode = failure ? sqlitePrimaryResultCode(failure.error) : undefined;
  (params.options?.logger ?? transactionLog).warn(
    failure ? "SQLite transaction lock wait failed" : "slow SQLite transaction step",
    {
      async: false,
      ...(params.options?.busyTimeoutMs !== undefined
        ? { busyTimeoutMs: params.options.busyTimeoutMs }
        : {}),
      ...transactionDiagnosticLabels(params.db, params.options),
      ...(failure ? { code: sqliteErrorCode(failure.error) } : {}),
      elapsedMs: params.elapsedMs,
      ...(failure ? { failureKind: "lock-contention" } : {}),
      isMainThread,
      pid: process.pid,
      ...(sqliteErrcode !== undefined ? { sqliteErrcode } : {}),
      ...(sqlitePrimaryCode !== undefined ? { sqlitePrimaryCode } : {}),
      step: params.step,
      threadId,
      ...(params.beginAdmission ? { beginAdmission: { ...params.beginAdmission } } : {}),
    },
  );
}

function execTimedTransactionStep(params: {
  db: DatabaseSync;
  options?: SqliteTransactionOptions;
  sql: string;
  step: SqliteTransactionStep;
}): number {
  const startedAt = Date.now();
  const beginAdmission =
    params.sql === "BEGIN IMMEDIATE"
      ? { nativeAttempts: 0, nativeMs: 0, serviceCalls: 0, serviceMs: 0 }
      : undefined;
  try {
    if (beginAdmission) {
      beginImmediateTransaction(params.db, beginAdmission);
    } else {
      params.db.exec(params.sql);
    }
    const elapsedMs = Date.now() - startedAt;
    logTransactionStep({
      beginAdmission,
      db: params.db,
      elapsedMs,
      options: params.options,
      step: params.step,
    });
    return elapsedMs;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (
      isSqliteLockError(error) &&
      shouldReportSqliteLockFailure(params.db) &&
      !(params.step === "begin" && params.options?.beginLockFailureReporting === "suppress")
    ) {
      logTransactionStep(
        { beginAdmission, db: params.db, elapsedMs, options: params.options, step: params.step },
        { error },
      );
    }
    throw error;
  }
}

function discardUnsafeConnection(db: TransactionDatabase, error: unknown): void {
  const aborted = { error };
  db[abortedTransactionSymbol] ??= aborted;
  try {
    discardSqliteTransactionState(db, error);
  } catch (rollbackError) {
    // Retain this failure's observer aggregate across outer and future admission checks.
    if (db[abortedTransactionSymbol] === aborted) {
      aborted.error = rollbackError;
    }
    throw rollbackError;
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    try {
      db.close();
    } catch {
      // Preserve the primary failure. The transaction helper also refuses reuse
      // if the handle was already closed or a lifecycle close hook failed.
    }
  }
}

function abortImmediateTransaction(
  db: TransactionDatabase,
  error: unknown,
  commitStarted: boolean,
): void {
  if (db[abortedTransactionSymbol]) {
    return;
  }
  // SQLITE_IOERR/FULL can roll back an operation before commit starts. Once
  // the commit owner runs, no transaction may instead mean a durable COMMIT
  // followed by a guard failure or rejected Promise: retain conservative fencing.
  if (!commitStarted && db.isOpen && !db.isTransaction) {
    discardSqliteTransactionState(db, error);
    return;
  }
  try {
    db.exec("ROLLBACK");
  } catch {
    // An abandoned transaction must not leak into later writes on this handle.
    discardUnsafeConnection(db, error);
  }
}

function runSqliteTransactionSync<T>(
  db: TransactionDatabase,
  operation: () => T,
  mode: SqliteTransactionMode,
  options?: SqliteTransactionOptions,
): T {
  if (db.isTransaction) {
    // SQLite targets the most recent matching savepoint. Reusing its name keeps
    // nested native/SDK calls correct without module-local depth or counters.
    db.exec("SAVEPOINT openclaw_tx_nested");
    try {
      const result = runSqliteReadOperationSync(db, operation);
      assertSyncTransactionResult(result);
      assertTransactionUsable(db);
      db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
      return result;
    } catch (error) {
      const failure = db[abortedTransactionSymbol];
      if (failure) {
        throw failure.error;
      }
      try {
        db.exec("ROLLBACK TO SAVEPOINT openclaw_tx_nested");
        db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
      } catch {
        // SQLITE_FULL and RAISE(ROLLBACK) can remove the entire transaction,
        // including its savepoints. Never let a caught failure autocommit later.
        discardUnsafeConnection(db, error);
      }
      throw error;
    }
  }

  const timing = currentSqliteOperationTiming();
  const prepareMs = timing ? Date.now() - timing.preparedAtMs : undefined;
  const beginMs = execTimedTransactionStep({
    db,
    options,
    sql: mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN",
    step: "begin",
  });
  return settleSqliteTransactionSync(db, operation, mode, beginMs, prepareMs, options);
}

/** Settle a reservation acquired by the closed, multi-database worker fence. */
export function runSqliteReservedTransactionSync<T>(
  db: DatabaseSync | PostgresSyncConnection,
  operation: () => T,
  options: SqliteTransactionOptions,
): T {
  if (db instanceof PostgresSyncConnection) {
    return runPostgresTransactionSync(db, operation, options, false, true, false);
  }
  assertTransactionUsable(db);
  if (isMainThread || !db.isTransaction) {
    throw new Error("SQLite reserved settlement requires a worker-owned transaction");
  }
  return settleSqliteTransactionSync(db, operation, "immediate", 0, undefined, options, true);
}

function settleSqliteTransactionSync<T>(
  db: TransactionDatabase,
  operation: () => T,
  mode: SqliteTransactionMode,
  beginMs: number,
  prepareMs: number | undefined,
  options: SqliteTransactionOptions | undefined,
  reservedSourceFence = false,
): T {
  const timing = currentSqliteOperationTiming();
  const transactionStartedAt = Date.now();
  const admissionWaitBefore = timing?.hostAdmissionWaitMs ?? 0;
  let commitMs = 0;
  const commit = () => {
    const startedAt = Date.now();
    try {
      execTimedTransactionStep({ db, options, sql: "COMMIT", step: "commit" });
    } finally {
      commitMs += Date.now() - startedAt;
    }
  };
  let commitStarted = false;
  try {
    // Share admitted schema inside rollback protection unless the source fence already owns it.
    const result = reservedSourceFence ? operation() : runSqliteReadOperationSync(db, operation);
    assertSyncTransactionResult(result);
    assertTransactionUsable(db);
    commitStarted = true;
    if (options?.withCommit) {
      assertSyncTransactionResult(options.withCommit(commit));
    } else {
      commit();
    }
    return result;
  } catch (error) {
    abortImmediateTransaction(db, error, commitStarted);
    assertTransactionUsable(db);
    throw error;
  } finally {
    // Include COMMIT and failed holders: both keep other writers waiting too.
    try {
      const elapsedMs = Date.now() - transactionStartedAt;
      const hostAdmissionWaitMs = (timing?.hostAdmissionWaitMs ?? 0) - admissionWaitBefore;
      logSlowTransactionHold({
        db,
        elapsedMs,
        mode,
        options,
        prepareMs,
        beginMs,
        hostAdmissionWaitMs,
        commitMs,
      });
    } catch {
      // Diagnostics cannot change an already-settled transaction's outcome.
    } finally {
      if (timing) {
        timing.preparedAtMs = Date.now();
      }
    }
  }
}

/** Run synchronous reads against one deferred SQLite snapshot. */
export function runSqliteDeferredTransactionSync<T>(
  db: DatabaseSync | PostgresSyncConnection,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  if (db instanceof PostgresSyncConnection) {
    return runPostgresTransactionSync(db, operation, options);
  }
  assertTransactionUsable(db);
  return withSqlitePostCommitPublications(db, () =>
    runSqliteTransactionSync(db, operation, "deferred", options),
  );
}

/** Read-only composition reuses the caller's snapshot and rollback owner. */
export function runSqliteReadSnapshotSync<T>(
  db: DatabaseSync | PostgresSyncConnection,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  if (db instanceof PostgresSyncConnection) {
    assertPostgresTransactionUsable(db);
    if (db.isTransaction) {
      const result = operation();
      assertSyncTransactionResult(result);
      assertPostgresTransactionUsable(db);
      return result;
    }
    return runPostgresTransactionSync(db, operation, options, true);
  }
  assertTransactionUsable(db);
  if (!db.isTransaction) {
    return runSqliteDeferredTransactionSync(db, operation, options);
  }
  const result = runSqliteReadOperationSync(db, operation);
  assertSyncTransactionResult(result);
  assertTransactionUsable(db);
  return result;
}

export function runSqliteImmediateTransactionSync<T>(
  ...args: [
    db: DatabaseSync | PostgresSyncConnection,
    operation: () => T,
    options?: SqliteTransactionOptions,
  ]
): T;
export function runSqliteImmediateTransactionSync<T>(
  ...args: [db: DatabaseSync, operation: () => T, options?: SqliteTransactionOptions]
): T;
export function runSqliteImmediateTransactionSync<T>(
  db: DatabaseSync | PostgresSyncConnection,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  if (db instanceof PostgresSyncConnection) {
    return runPostgresTransactionSync(db, operation, options);
  }
  assertTransactionUsable(db);
  return withSqlitePostCommitPublications(db, () =>
    runSqliteTransactionSync(db, operation, "immediate", options),
  );
}

/**
 * Execute one complete statement, then publish its receipts. Prepare inputs before
 * calling; the callback must not do fallible work after the native statement.
 * Existing transactions retain their savepoint and outer publication owner.
 */
export function runSqliteSingleStatementSync<T>(db: DatabaseSync, statement: () => T): T {
  assertTransactionUsable(db);
  return withSqlitePostCommitPublications(db, () => {
    if (db.isTransaction) {
      return runSqliteTransactionSync(db, statement, "immediate");
    }
    const result = runSqliteReadOperationSync(db, statement);
    assertSyncTransactionResult(result);
    return result;
  });
}

/** Obtain host admission before taking the writer lock; revalidate before physical commit. */
export function runSqliteWorkerTransactionSync<T>(
  context: Omit<SqliteWorkerDatabaseContext, "database"> & {
    database: DatabaseSync | PostgresSyncConnection;
  },
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  if (context.database instanceof PostgresSyncConnection) {
    return runPostgresTransactionSync(
      context.database,
      () => {
        context.admit("transaction");
        return operation();
      },
      {
        ...options,
        withCommit(commit) {
          context.admit("commit");
          return options?.withCommit ? options.withCommit(commit) : commit();
        },
      },
      false,
      false,
      false,
    );
  }
  assertTransactionUsable(context.database);
  context.admit("transaction");
  return runSqliteImmediateTransactionSync(context.database, operation, {
    ...options,
    withCommit(commit) {
      context.admit("commit");
      return options?.withCommit ? options.withCommit(commit) : commit();
    },
  });
}

/** Prepare outside the transaction; yield for admission without replaying admitted writes. */
export async function runSqliteImmediateTransaction<T>(
  db: DatabaseSync | PostgresSyncConnection,
  prepare: () => Promise<(() => T) | undefined>,
  options?: SqliteTransactionOptions,
  admit: (write: () => T) => T | Promise<T> = (write) => write(),
): Promise<T | undefined> {
  if (db instanceof PostgresSyncConnection) {
    assertPostgresTransactionUsable(db);
    if (db.isTransaction) {
      throw new Error("Asynchronous SQLite preparation cannot join an existing transaction");
    }
    const operation = await prepare();
    assertPostgresTransactionUsable(db);
    if (db.isTransaction) {
      throw new Error("SQLite preparation left a transaction open");
    }
    if (!operation) {
      return undefined;
    }
    return await admit(() => {
      assertPostgresTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Asynchronous SQLite preparation cannot join an existing transaction");
      }
      return runPostgresTransactionSync(db, operation, options);
    });
  }
  assertTransactionUsable(db);
  if (db.isTransaction) {
    throw new Error("Asynchronous SQLite preparation cannot join an existing transaction");
  }
  const inheritedDeadlineNs = options?.beginDeadlineNs;
  const remainingMs = (() => {
    if (inheritedDeadlineNs !== undefined) {
      return () => Number(inheritedDeadlineNs - process.hrtime.bigint()) / 1_000_000;
    }
    const deadline = performance.now() + readSqliteBusyTimeout(db);
    return () => deadline - performance.now();
  })();
  let entered = false;
  while (true) {
    const operation = await prepare();
    assertTransactionUsable(db);
    if (db.isTransaction) {
      throw new Error("SQLite preparation left a transaction open");
    }
    if (!operation) {
      return undefined;
    }
    try {
      return await admit(() => {
        assertTransactionUsable(db);
        // Owner admission may wait; never join a transaction opened during that wait.
        if (db.isTransaction) {
          throw new Error("Asynchronous SQLite preparation cannot join an existing transaction");
        }
        return runWithSqliteBusyTimeout(
          db,
          0,
          (restore) =>
            runSqliteImmediateTransactionSync(
              db,
              () => {
                entered = true;
                restore();
                return operation();
              },
              options,
            ),
          { lockFailureReporting: "suppress" },
        );
      });
    } catch (error) {
      if (entered || !isSqliteLockError(error) || remainingMs() <= 0) {
        throw error;
      }
      // The synchronous helper restored connection policy and left no transaction.
      await sleep(Math.min(25, Math.max(0, remainingMs())));
      assertTransactionUsable(db);
      if (remainingMs() <= 0) {
        throw error;
      }
    }
  }
}
