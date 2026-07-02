// Provides SQLite transaction helpers with nested savepoints.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

const transactionDepthByDatabase = new WeakMap<DatabaseSync, number>();
const transactionContext = new AsyncLocalStorage<{ depths: Map<DatabaseSync, number> }>();

const RETRYABLE_SQLITE_LOCK_ERROR_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);
const MAX_TRANSACTION_LOCK_ATTEMPTS = 8;
const DEFAULT_MAX_BUSY_WAIT_MS = 30_000;
const DEFAULT_SLOW_BUSY_WAIT_MS = 1_000;

let nextSavepointId = 0;
const transactionLog = createSubsystemLogger("sqlite/transaction");

export type SqliteTransactionOptions = {
  busyTimeoutMs?: number;
  databaseLabel?: string;
  logger?: Pick<SubsystemLogger, "warn">;
  maxBusyWaitMs?: number;
};

type SqliteTransactionStep = "begin" | "commit";

type TimedSqliteError = Error & {
  code?: string;
  sqliteElapsedMs?: number;
};

function nextSavepointName(): string {
  nextSavepointId += 1;
  return `openclaw_tx_${nextSavepointId}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}

function assertSyncTransactionResult(value: unknown): void {
  if (isPromiseLike(value)) {
    throw new Error(
      "SQLite write transactions must be synchronous; Promise returns are not supported.",
    );
  }
}

function sqliteErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function isRetryableTransactionLockError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  return code !== undefined && RETRYABLE_SQLITE_LOCK_ERROR_CODES.has(code);
}

function transactionElapsedMs(error: unknown): number {
  const elapsedMs =
    error && typeof error === "object"
      ? (error as { sqliteElapsedMs?: unknown }).sqliteElapsedMs
      : undefined;
  return typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? elapsedMs : 0;
}

function withTimedSqliteError(error: unknown, elapsedMs: number): TimedSqliteError {
  if (error instanceof Error) {
    return Object.assign(error, { sqliteElapsedMs: elapsedMs });
  }
  return Object.assign(new Error(String(error)), { sqliteElapsedMs: elapsedMs });
}

function effectiveMaxBusyWaitMs(options: SqliteTransactionOptions | undefined): number {
  return options?.maxBusyWaitMs ?? DEFAULT_MAX_BUSY_WAIT_MS;
}

function slowBusyWaitThresholdMs(options: SqliteTransactionOptions | undefined): number {
  if (options?.busyTimeoutMs === undefined) {
    return DEFAULT_SLOW_BUSY_WAIT_MS;
  }
  return Math.min(DEFAULT_SLOW_BUSY_WAIT_MS, Math.max(1, options.busyTimeoutMs));
}

function transactionLogger(
  options: SqliteTransactionOptions | undefined,
): Pick<SubsystemLogger, "warn"> {
  return options?.logger ?? transactionLog;
}

function logSlowTransactionStep(params: {
  attempt?: number;
  elapsedMs: number;
  options?: SqliteTransactionOptions;
  step: SqliteTransactionStep;
}): void {
  if (params.elapsedMs < slowBusyWaitThresholdMs(params.options)) {
    return;
  }
  transactionLogger(params.options).warn("slow SQLite transaction lock wait", {
    ...(params.attempt !== undefined ? { attempt: params.attempt } : {}),
    ...(params.options?.busyTimeoutMs !== undefined
      ? { busyTimeoutMs: params.options.busyTimeoutMs }
      : {}),
    ...(params.options?.databaseLabel ? { database: params.options.databaseLabel } : {}),
    elapsedMs: params.elapsedMs,
    maxBusyWaitMs: effectiveMaxBusyWaitMs(params.options),
    step: params.step,
  });
}

function execTimedTransactionStep(params: {
  attempt?: number;
  db: DatabaseSync;
  options?: SqliteTransactionOptions;
  sql: string;
  step: SqliteTransactionStep;
}): number {
  const startedAt = Date.now();
  try {
    params.db.exec(params.sql);
    const elapsedMs = Date.now() - startedAt;
    logSlowTransactionStep({
      attempt: params.attempt,
      elapsedMs,
      options: params.options,
      step: params.step,
    });
    return elapsedMs;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (isRetryableTransactionLockError(error)) {
      transactionLogger(params.options).warn("SQLite transaction lock wait failed", {
        ...(params.attempt !== undefined ? { attempt: params.attempt } : {}),
        ...(params.options?.busyTimeoutMs !== undefined
          ? { busyTimeoutMs: params.options.busyTimeoutMs }
          : {}),
        ...(params.options?.databaseLabel ? { database: params.options.databaseLabel } : {}),
        code: sqliteErrorCode(error),
        elapsedMs,
        maxBusyWaitMs: effectiveMaxBusyWaitMs(params.options),
        step: params.step,
      });
    }
    throw withTimedSqliteError(error, elapsedMs);
  }
}

function sqliteBusyTimeoutError(params: {
  attempts: number;
  cause: unknown;
  options?: SqliteTransactionOptions;
  step: SqliteTransactionStep;
  waitMs: number;
}): TimedSqliteError {
  const code = sqliteErrorCode(params.cause);
  const label = params.options?.databaseLabel ? ` for ${params.options.databaseLabel}` : "";
  const timeout = params.options?.busyTimeoutMs;
  const timeoutLabel = timeout === undefined ? "" : `; busy_timeout=${timeout}ms`;
  const message = `SQLite transaction ${params.step}${label} timed out after waiting ${params.waitMs}ms across ${params.attempts} attempt(s)${timeoutLabel}: ${String(params.cause)}`;
  return Object.assign(new Error(message, { cause: params.cause }), {
    ...(code ? { code } : {}),
    sqliteElapsedMs: params.waitMs,
  });
}

function beginImmediateTransaction(
  db: DatabaseSync,
  options: SqliteTransactionOptions | undefined,
): void {
  runRetryableTransactionLockStep({
    db,
    options,
    sql: "BEGIN IMMEDIATE",
    step: "begin",
  });
}

function commitImmediateTransaction(
  db: DatabaseSync,
  options: SqliteTransactionOptions | undefined,
): void {
  runRetryableTransactionLockStep({
    db,
    options,
    sql: "COMMIT",
    step: "commit",
  });
}

function runRetryableTransactionLockStep(params: {
  db: DatabaseSync;
  options: SqliteTransactionOptions | undefined;
  sql: string;
  step: SqliteTransactionStep;
}): void {
  let busyWaitMs = 0;
  for (const attempt of Array.from(
    { length: MAX_TRANSACTION_LOCK_ATTEMPTS },
    (_, index) => index + 1,
  )) {
    try {
      execTimedTransactionStep({ attempt, ...params });
      return;
    } catch (error) {
      busyWaitMs += transactionElapsedMs(error);
      const exhaustedAttempts = attempt >= MAX_TRANSACTION_LOCK_ATTEMPTS;
      const exhaustedWait = busyWaitMs >= effectiveMaxBusyWaitMs(params.options);
      if (!isRetryableTransactionLockError(error)) {
        throw error;
      }
      if (exhaustedAttempts || exhaustedWait) {
        throw sqliteBusyTimeoutError({
          attempts: attempt,
          cause: error,
          options: params.options,
          step: params.step,
          waitMs: busyWaitMs,
        });
      }
    }
  }
}

function abortImmediateTransaction(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // If rollback itself fails, close the handle so callers cannot keep using a
    // connection that may still hold an abandoned write transaction.
    try {
      db.close();
    } catch {
      // Preserve the original transaction error; close failure is secondary.
    }
  }
}

function getTransactionDepth(db: DatabaseSync): number {
  const contextDepth = transactionContext.getStore()?.depths.get(db);
  if (contextDepth !== undefined) {
    return contextDepth;
  }
  return transactionDepthByDatabase.get(db) ?? 0;
}

function setTransactionDepth(db: DatabaseSync, depth: number): void {
  const contextDepths = transactionContext.getStore()?.depths;
  if (contextDepths?.has(db)) {
    if (depth <= 0) {
      contextDepths.delete(db);
      return;
    }
    contextDepths.set(db, depth);
    return;
  }
  if (depth <= 0) {
    transactionDepthByDatabase.delete(db);
    return;
  }
  transactionDepthByDatabase.set(db, depth);
}

export function runSqliteImmediateTransactionSync<T>(
  db: DatabaseSync,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  const depth = getTransactionDepth(db);
  if (depth > 0) {
    const savepointName = nextSavepointName();
    db.exec(`SAVEPOINT ${savepointName}`);
    setTransactionDepth(db, depth + 1);
    try {
      const result = operation();
      assertSyncTransactionResult(result);
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      } finally {
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }
      throw error;
    } finally {
      setTransactionDepth(db, depth);
    }
  }

  beginImmediateTransaction(db, options);
  setTransactionDepth(db, 1);
  let transactionStillActive = true;
  let result: T;
  try {
    result = operation();
    assertSyncTransactionResult(result);
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }

  try {
    commitImmediateTransaction(db, options);
    transactionStillActive = false;
    return result;
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }
}

/** Run an async callback inside a SQLite immediate transaction. */
export async function runSqliteImmediateTransactionAsync<T>(
  db: DatabaseSync,
  operation: () => Promise<T> | T,
  options?: SqliteTransactionOptions,
): Promise<T> {
  const depth = getTransactionDepth(db);
  if (depth > 0) {
    const savepointName = nextSavepointName();
    db.exec(`SAVEPOINT ${savepointName}`);
    setTransactionDepth(db, depth + 1);
    try {
      const result = await operation();
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      } finally {
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }
      throw error;
    } finally {
      setTransactionDepth(db, depth);
    }
  }

  beginImmediateTransaction(db, options);
  let transactionStillActive = true;
  let result: T;
  const parentContext = transactionContext.getStore();
  const transactionDepths = new Map(parentContext?.depths);
  transactionDepths.set(db, 1);
  try {
    result = await transactionContext.run({ depths: transactionDepths }, async () => {
      return await operation();
    });
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }

  try {
    commitImmediateTransaction(db, options);
    transactionStillActive = false;
    return result;
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }
}
