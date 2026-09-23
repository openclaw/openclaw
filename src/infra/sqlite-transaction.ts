// Provides SQLite transaction helpers with nested savepoints.
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainThread, threadId } from "node:worker_threads";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
// The cache-state module keeps this lifecycle edge off the kysely value graph
// so cold control-plane paths using transactions do not load kysely.
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeWithCachedStatement,
} from "./kysely-sync-cache-state.js";
import { normalizeWindowsPathPreservingCase } from "./path-guards.js";
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
import { discardSqliteTransactionState } from "./sqlite-post-commit.js";

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
  const canonical = location === null ? null : normalizeWriteAdmissionLocation(location);
  writeAdmissionLocations.set(database, canonical);
  return canonical;
}

function normalizeWriteAdmissionLocation(location: string): string {
  const normalized =
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(location) : location;
  return process.platform === "win32" && !path.win32.isAbsolute(normalized) ? location : normalized;
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
  const locations = new Set(nativeLocations.map(normalizeWriteAdmissionLocation));
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

/** Native coordinator waits must keep the same worker's current-authority grants serviceable. */
export function sqliteWriteAdmissionServicesForLocation(
  location: string,
): ReadonlySet<() => void> | undefined {
  return writeAdmissionServices.get(normalizeWriteAdmissionLocation(location));
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
  busyTimeoutMs?: number;
  databaseLabel?: string;
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

function slowTransactionHoldThresholdMs(options: SqliteTransactionOptions | undefined): number {
  return options?.slowTransactionHoldMs ?? DEFAULT_SLOW_TRANSACTION_HOLD_MS;
}

function transactionLogger(
  options: SqliteTransactionOptions | undefined,
): Pick<SubsystemLogger, "warn"> {
  return options?.logger ?? transactionLog;
}

function logSlowTransactionHold(params: {
  elapsedMs: number;
  options?: SqliteTransactionOptions;
}): void {
  if (params.elapsedMs < slowTransactionHoldThresholdMs(params.options)) {
    return;
  }
  transactionLogger(params.options).warn("slow SQLite transaction hold", {
    async: false,
    ...(params.options?.databaseLabel ? { database: params.options.databaseLabel } : {}),
    elapsedMs: params.elapsedMs,
    isMainThread,
    ...(params.options?.operationLabel ? { operation: params.options.operationLabel } : {}),
    pid: process.pid,
    threadId,
    thresholdMs: slowTransactionHoldThresholdMs(params.options),
  });
}

/** The lifecycle lock precedes BEGIN, so transaction hold diagnostics cannot see this wait. */
export function logSlowSqliteCoordinatorWait(
  elapsedMs: number,
  options: Pick<SqliteTransactionOptions, "databaseLabel" | "operationLabel">,
): void {
  if (!isMainThread || elapsedMs <= 100) {
    return;
  }
  transactionLogger(undefined).warn("slow SQLite coordinator lock wait", {
    async: false,
    database: options.databaseLabel,
    elapsedMs,
    isMainThread,
    operation: options.operationLabel,
    pid: process.pid,
    threadId,
    thresholdMs: 100,
  });
}

function logSlowTransactionStep(params: {
  beginAdmission?: SqliteBeginAdmissionDiagnostics;
  elapsedMs: number;
  options?: SqliteTransactionOptions;
  step: SqliteTransactionStep;
}): void {
  if (params.elapsedMs < slowBusyWaitThresholdMs(params.options)) {
    return;
  }
  transactionLogger(params.options).warn("slow SQLite transaction lock wait", {
    async: false,
    ...(params.options?.busyTimeoutMs !== undefined
      ? { busyTimeoutMs: params.options.busyTimeoutMs }
      : {}),
    ...(params.options?.databaseLabel ? { database: params.options.databaseLabel } : {}),
    elapsedMs: params.elapsedMs,
    isMainThread,
    ...(params.options?.operationLabel ? { operation: params.options.operationLabel } : {}),
    pid: process.pid,
    step: params.step,
    threadId,
    ...beginAdmissionLogFields(params.beginAdmission),
  });
}

function beginAdmissionLogFields(diagnostics: SqliteBeginAdmissionDiagnostics | undefined) {
  return diagnostics
    ? {
        beginAdmission: {
          nativeAttempts: diagnostics.nativeAttempts,
          nativeMs: diagnostics.nativeMs,
          serviceCalls: diagnostics.serviceCalls,
          serviceMs: diagnostics.serviceMs,
        },
      }
    : {};
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
    logSlowTransactionStep({
      beginAdmission,
      elapsedMs,
      options: params.options,
      step: params.step,
    });
    return elapsedMs;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (isSqliteLockError(error) && shouldReportSqliteLockFailure(params.db)) {
      const sqliteErrcode = sqliteExtendedResultCode(error);
      const sqlitePrimaryCode = sqlitePrimaryResultCode(error);
      transactionLogger(params.options).warn("SQLite transaction lock wait failed", {
        async: false,
        ...(params.options?.busyTimeoutMs !== undefined
          ? { busyTimeoutMs: params.options.busyTimeoutMs }
          : {}),
        ...(params.options?.databaseLabel ? { database: params.options.databaseLabel } : {}),
        code: sqliteErrorCode(error),
        elapsedMs,
        failureKind: "lock-contention",
        isMainThread,
        ...(params.options?.operationLabel ? { operation: params.options.operationLabel } : {}),
        pid: process.pid,
        ...(sqliteErrcode !== undefined ? { sqliteErrcode } : {}),
        ...(sqlitePrimaryCode !== undefined ? { sqlitePrimaryCode } : {}),
        step: params.step,
        threadId,
        ...beginAdmissionLogFields(beginAdmission),
      });
    }
    throw error;
  }
}

function beginTransaction(
  db: DatabaseSync,
  options: SqliteTransactionOptions | undefined,
  mode: SqliteTransactionMode,
): void {
  execTimedTransactionStep({
    db,
    options,
    sql: mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN",
    step: "begin",
  });
}

function commitImmediateTransaction(
  db: DatabaseSync,
  options: SqliteTransactionOptions | undefined,
): void {
  execTimedTransactionStep({
    db,
    options,
    sql: "COMMIT",
    step: "commit",
  });
}

function discardUnsafeConnection(db: TransactionDatabase, error: unknown): void {
  db[abortedTransactionSymbol] ??= { error };
  discardSqliteTransactionState(db, error);
  clearNodeSqliteKyselyCacheForDatabase(db);
  try {
    db.close();
  } catch {
    // Preserve the primary failure. The transaction helper also refuses reuse
    // if the handle was already closed or a lifecycle close hook failed.
  }
}

function abortImmediateTransaction(db: TransactionDatabase, error: unknown): void {
  if (db[abortedTransactionSymbol]) {
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
  assertTransactionUsable(db);
  if (db.isTransaction) {
    // SQLite targets the most recent matching savepoint. Reusing its name keeps
    // nested native/SDK calls correct without module-local depth or counters.
    db.exec("SAVEPOINT openclaw_tx_nested");
    try {
      const result = operation();
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

  beginTransaction(db, options, mode);
  const transactionStartedAt = Date.now();
  try {
    const result = operation();
    assertSyncTransactionResult(result);
    assertTransactionUsable(db);
    if (options?.withCommit) {
      assertSyncTransactionResult(
        options.withCommit(() => commitImmediateTransaction(db, options)),
      );
    } else {
      commitImmediateTransaction(db, options);
    }
    return result;
  } catch (error) {
    abortImmediateTransaction(db, error);
    assertTransactionUsable(db);
    throw error;
  } finally {
    // Include COMMIT and failed holders: both keep other writers waiting too.
    try {
      logSlowTransactionHold({
        elapsedMs: Date.now() - transactionStartedAt,
        options,
      });
    } catch {
      // Diagnostics cannot change an already-settled transaction's outcome.
    }
  }
}

/** Run synchronous reads against one deferred SQLite snapshot. */
export function runSqliteDeferredTransactionSync<T>(
  db: DatabaseSync,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  return runSqliteTransactionSync(db, operation, "deferred", options);
}

/** Pin an implicit read snapshot without requiring transaction-control authorization. */
export function runSqlitePinnedReadSnapshotSync<T>(db: DatabaseSync, operation: () => T): T {
  return executeWithCachedStatement(db, "PRAGMA schema_version", [], (statement) => {
    // sqlite-allow-raw: Stepping this pragma pins the connection's implicit read transaction.
    const snapshot = statement.iterate();
    try {
      const first = snapshot.next();
      if (first.done) {
        throw new Error("SQLite schema version query returned no row");
      }
      return operation();
    } finally {
      snapshot.return?.();
    }
  });
}

export function runSqliteImmediateTransactionSync<T>(
  db: DatabaseSync,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  return runSqliteTransactionSync(db, operation, "immediate", options);
}

/** Prepare outside the transaction; yield for admission without replaying admitted writes. */
export async function runSqliteImmediateTransaction<T>(
  db: DatabaseSync,
  prepare: () => Promise<(() => T) | undefined>,
  options?: SqliteTransactionOptions,
  admit: (write: () => T) => T | Promise<T> = (write) => write(),
): Promise<T | undefined> {
  assertTransactionUsable(db);
  if (db.isTransaction) {
    throw new Error("Asynchronous SQLite preparation cannot join an existing transaction");
  }
  const deadline = performance.now() + readSqliteBusyTimeout(db);
  const inheritedDeadlineNs = options?.beginDeadlineNs;
  const remainingMs =
    inheritedDeadlineNs === undefined
      ? () => deadline - performance.now()
      : () => Number(inheritedDeadlineNs - process.hrtime.bigint()) / 1_000_000;
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
