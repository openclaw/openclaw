import type { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { readSqliteTransactionWriter } from "./sqlite-database-admission-context.js";
import {
  sqliteErrorCode,
  sqliteExtendedResultCode,
  sqlitePrimaryResultCode,
} from "./sqlite-error-diagnostics.js";
import { captureSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import type { SqliteTransactionOptions } from "./sqlite-transaction-types.js";

const DEFAULT_SLOW_BUSY_WAIT_MS = 1_000;
export const transactionLog = createSubsystemLogger("sqlite/transaction");

export type SqliteBeginAdmissionDiagnostics = {
  nativeAttempts: number;
  nativeMs: number;
  serviceCalls: number;
  serviceMs: number;
};

export function transactionDiagnosticLabels(
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

function slowBusyWaitThresholdMs(options: SqliteTransactionOptions | undefined): number {
  if (options?.busyTimeoutMs === undefined || options.busyTimeoutMs <= 0) {
    return DEFAULT_SLOW_BUSY_WAIT_MS;
  }
  return Math.min(DEFAULT_SLOW_BUSY_WAIT_MS, options.busyTimeoutMs);
}

export function logTransactionStep(
  params: {
    beginAdmission?: SqliteBeginAdmissionDiagnostics;
    db: DatabaseSync;
    elapsedMs: number;
    holderAtWaitStart?: ReturnType<typeof readSqliteTransactionWriter>;
    options?: SqliteTransactionOptions;
    step: "begin" | "commit";
    transactionId: string;
  },
  failure?: { error: unknown },
): void {
  try {
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
        ...(params.holderAtWaitStart ? { holderAtWaitStart: params.holderAtWaitStart } : {}),
        ...(failure ? { failureKind: "lock-contention" } : {}),
        isMainThread,
        pid: process.pid,
        ...(sqliteErrcode !== undefined ? { sqliteErrcode } : {}),
        ...(sqlitePrimaryCode !== undefined ? { sqlitePrimaryCode } : {}),
        step: params.step,
        threadId,
        transactionId: params.transactionId,
        ...(params.beginAdmission ? { beginAdmission: { ...params.beginAdmission } } : {}),
      },
    );
  } catch {
    // Diagnostics cannot change transaction outcomes or replace the native failure.
  }
}
