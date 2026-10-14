import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerNodeSqliteDisposeCallback } from "./kysely-sync-cache-state.js";

export type SqliteLockFailureReporting = "report" | "suppress";

const lockFailureReportingByDatabase = new WeakMap<DatabaseSync, SqliteLockFailureReporting>();
const { busyTimeoutByDatabase, trackedDatabases } = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteBusyTimeout"),
  () => ({
    busyTimeoutByDatabase: new WeakMap<DatabaseSync, number>(),
    trackedDatabases: new WeakSet<DatabaseSync>(),
  }),
);

function rememberSqliteBusyTimeout(database: DatabaseSync, busyTimeoutMs: number): void {
  if (!trackedDatabases.has(database)) {
    trackedDatabases.add(database);
    registerNodeSqliteDisposeCallback(database, () => busyTimeoutByDatabase.delete(database));
  }
  busyTimeoutByDatabase.set(database, busyTimeoutMs);
}

export function normalizeSqliteNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

export function readSqliteBusyTimeout(database: DatabaseSync): number {
  const known = busyTimeoutByDatabase.get(database);
  if (known !== undefined) {
    return known;
  }
  const row = database // sqlite-allow-raw -- Adopt an unmanaged connection's initial policy once.
    .prepare("PRAGMA busy_timeout")
    .get();
  const value = row?.busy_timeout ?? row?.timeout;
  const busyTimeoutMs = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  rememberSqliteBusyTimeout(database, busyTimeoutMs);
  return busyTimeoutMs;
}

/** All policy changes on a managed connection go through this owner. */
export function setSqliteBusyTimeout(database: DatabaseSync, busyTimeoutMs: number): void {
  const normalizedTimeoutMs = normalizeSqliteNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  if (busyTimeoutByDatabase.get(database) === normalizedTimeoutMs) {
    return;
  }
  database.exec(`PRAGMA busy_timeout = ${normalizedTimeoutMs}`); // sqlite-allow-raw -- Connection-local lock policy.
  rememberSqliteBusyTimeout(database, normalizedTimeoutMs);
}

export function shouldReportSqliteLockFailure(database: DatabaseSync): boolean {
  return lockFailureReportingByDatabase.get(database) !== "suppress";
}

/** Run with a temporary busy policy; restore early when write admission finishes. */
export function runWithSqliteBusyTimeout<T>(
  database: DatabaseSync,
  busyTimeoutMs: number,
  operation: (restore: () => void) => T,
  options: { lockFailureReporting?: SqliteLockFailureReporting } = {},
): T {
  const normalizedTimeoutMs = normalizeSqliteNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  const previousBusyTimeoutMs = readSqliteBusyTimeout(database);
  const previousLockFailureReporting = lockFailureReportingByDatabase.get(database);
  if (options.lockFailureReporting) {
    lockFailureReportingByDatabase.set(database, options.lockFailureReporting);
  }
  setSqliteBusyTimeout(database, normalizedTimeoutMs);
  let restored = false;
  const restore = () => {
    if (restored) {
      return;
    }
    if (database.isOpen && previousBusyTimeoutMs !== normalizedTimeoutMs) {
      setSqliteBusyTimeout(database, previousBusyTimeoutMs);
    }
    if (previousLockFailureReporting) {
      lockFailureReportingByDatabase.set(database, previousLockFailureReporting);
    } else {
      lockFailureReportingByDatabase.delete(database);
    }
    restored = true;
  };
  try {
    return operation(restore);
  } finally {
    restore();
  }
}
