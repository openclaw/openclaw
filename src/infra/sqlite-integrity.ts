import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { recordSqliteDatabaseIntegrity } from "./sqlite-database-admission.js";
import { isSqliteCorruptionError } from "./sqlite-error-diagnostics.js";
import {
  consumeSqliteMaintenanceIntegrity,
  type SqliteIntegrityCheckOptions,
} from "./sqlite-maintenance-integrity.js";
import { readSqliteSchemaObjects } from "./sqlite-schema-admission.js";
import { getMaintenanceSqliteTableChecks } from "./sqlite-table-integrity-cache.js";

export type { SqliteIntegrityCheckOptions } from "./sqlite-maintenance-integrity.js";

type SqliteIntegrityChecks = {
  integrityCheck: "ok";
};

export type SqliteIntegrityCheckTiming = {
  syncElapsedMs?: number;
  workerCheckElapsedMs?: number;
  workerLifetimeElapsedMs?: number;
};

export type SqliteIntegrityCheck = SqliteIntegrityCheckOptions & {
  database: DatabaseSync;
  databaseLabel: string;
  timing?: SqliteIntegrityCheckTiming;
};

export type SqliteIntegrityOperation<T> = Generator<SqliteIntegrityCheck, T, void>;

export type SqliteIntegrityDiagnostics = {
  because?: string;
  integrityGateReason?:
    | "revoked"
    | "stale-lease-full"
    | "process-death"
    | "dirty-receipt"
    | "no-proof"
    | "lease-class";
  integrityGateMode?: "quick" | "full" | "deferred";
  integrityGateMs?: number;
  integrityGateOutcome?: "healthy" | "failed" | "cached" | "pending";
  integrityCheckSyncMs?: number;
  integrityOutsideCheckMs?: number;
  integrityWorkerCheckMs?: number;
  integrityWorkerLifetimeMs?: number;
  integrityOutsideWorkerMs?: number;
  canonicalIndexMs?: number;
  repairedIndexCount?: number;
};

/** The gate includes the driver's check, awaited lifetime, and admission revalidation. */
export function* sqliteIntegrityCheckSteps(
  database: DatabaseSync,
  databaseLabel: string,
  diagnostics?: SqliteIntegrityDiagnostics,
  options: SqliteIntegrityCheckOptions = {},
): SqliteIntegrityOperation<void> {
  if (consumeSqliteMaintenanceIntegrity(database, databaseLabel, options)) {
    if (diagnostics) {
      diagnostics.integrityGateMode = "quick";
      diagnostics.integrityGateOutcome = "cached";
    }
    return;
  }
  const startedAt = performance.now();
  const check: SqliteIntegrityCheck = { database, databaseLabel, ...options };
  if (diagnostics) {
    check.timing = {};
    diagnostics.integrityGateMode = options.check ?? "full";
    // A later async driver must not inherit an earlier gate's synchronous measurement.
    delete diagnostics.integrityCheckSyncMs;
    delete diagnostics.integrityOutsideCheckMs;
    delete diagnostics.integrityWorkerCheckMs;
    delete diagnostics.integrityWorkerLifetimeMs;
    delete diagnostics.integrityOutsideWorkerMs;
  }
  try {
    yield check;
    if (diagnostics) {
      diagnostics.integrityGateOutcome = "healthy";
    }
  } catch (error) {
    if (diagnostics) {
      diagnostics.integrityGateOutcome = "failed";
    }
    throw error;
  } finally {
    if (diagnostics) {
      diagnostics.integrityGateMs = Math.floor(performance.now() - startedAt);
      if (check.timing?.syncElapsedMs !== undefined) {
        diagnostics.integrityCheckSyncMs = Math.floor(check.timing.syncElapsedMs);
        diagnostics.integrityOutsideCheckMs =
          diagnostics.integrityGateMs - diagnostics.integrityCheckSyncMs;
      }
      if (check.timing?.workerCheckElapsedMs !== undefined) {
        diagnostics.integrityWorkerCheckMs = Math.floor(check.timing.workerCheckElapsedMs);
      }
      if (check.timing?.workerLifetimeElapsedMs !== undefined) {
        diagnostics.integrityWorkerLifetimeMs = Math.floor(check.timing.workerLifetimeElapsedMs);
        diagnostics.integrityOutsideWorkerMs =
          diagnostics.integrityGateMs - diagnostics.integrityWorkerLifetimeMs;
      }
    }
  }
}

/** Measure only the calling driver's synchronous check, excluding admission and resumption. */
export function runSqliteIntegrityCheckSync(check: SqliteIntegrityCheck): void {
  const timing = check.timing;
  const startedAt = timing ? performance.now() : 0;
  try {
    assertSqliteIntegrity(check.database, check.databaseLabel, check);
  } finally {
    if (timing) {
      timing.syncElapsedMs = performance.now() - startedAt;
    }
  }
}

/** Run the same admission steps synchronously when the caller cannot yield. */
export function runSqliteIntegrityOperationSync<T>(
  operation: SqliteIntegrityOperation<T>,
  beforeResume?: () => void,
): T {
  beforeResume?.();
  let step = operation.next();
  while (!step.done) {
    let failure: { error: unknown } | undefined;
    try {
      runSqliteIntegrityCheckSync(step.value);
    } catch (error) {
      failure = { error };
    }
    // A blocking check can outlive its caller; both success and failure resume schema work.
    beforeResume?.();
    step = failure ? operation.throw(failure.error) : operation.next();
  }
  return step.value;
}

type SqliteCheckPragma = "integrity_check" | "quick_check";
type SqliteForeignKeyViolation = {
  fkid: bigint;
  parent: string;
  rowid: bigint | null;
  table: string;
};

const MAX_REPORTED_FOREIGN_KEY_VIOLATIONS = 5;

// Released pre-v19 databases can reach updater-ledger admission with this exact
// orphan relation. Keep classification separate from permission: only the
// update admission or fenced v19 migration owner may accept this typed refusal.
export class SqliteRepairableForeignKeyError extends Error {
  readonly repair: Readonly<{
    kind: "task-delivery-orphans";
    relation: "task_delivery_state.task_id";
    parentTable: "task_runs";
    orphanCount: number;
  }>;

  constructor(databaseLabel: string, orphanCount: number) {
    super(
      `SQLite foreign_key_check failed for ${databaseLabel}: repairable task_delivery_state.task_id references task_runs.task_id cascade-owned orphans (${orphanCount} rows). Run openclaw doctor --fix to migrate this legacy state before retrying.`,
    );
    this.name = "SqliteRepairableForeignKeyError";
    this.repair = {
      kind: "task-delivery-orphans",
      relation: "task_delivery_state.task_id",
      parentTable: "task_runs",
      orphanCount,
    };
  }
}

/** Return whether a named integrity failure proves persistent database damage. */
export function isTerminalSqliteIntegrityError(error: Error): boolean {
  if (error.name !== "SqliteIntegrityError") {
    return false;
  }
  if (!error.cause) {
    // No cause means the check pragma itself reported corruption rows: persistent.
    return true;
  }
  // Only proven corruption latches; transient lock/busy pragma failures must not.
  return isSqliteCorruptionError(error.cause);
}

/** Check structure and foreign keys, plus all indexes or the migration's selected tables. */
export function assertSqliteIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
  options: SqliteIntegrityCheckOptions = {},
): SqliteIntegrityChecks {
  const check = options.check === "quick" ? "quick_check" : "integrity_check";
  const integrityCheck = runSqliteCheck(database, databaseLabel, check);
  if (check === "quick_check" && options.tables?.length) {
    const existing = new Set(
      readSqliteSchemaObjects(database)
        .filter((row) => row.type === "table")
        .map((row) => row.name),
    );
    for (const table of options.tables) {
      if (existing.has(table)) {
        assertSqliteTableIntegrity(database, databaseLabel, table);
      }
    }
  }
  runSqliteForeignKeyCheck(database, databaseLabel);
  if (check === "integrity_check") {
    recordSqliteDatabaseIntegrity(database);
  }
  return { integrityCheck };
}

/** Require table and associated index consistency before trusting indexed reads. */
export function assertSqliteTableIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
  tableName: string,
): void {
  const checked = getMaintenanceSqliteTableChecks(database);
  if (checked?.has(tableName)) {
    return;
  }
  runSqliteCheck(database, `${databaseLabel} table ${tableName}`, "integrity_check", tableName);
  checked?.add(tableName);
}

function runSqliteCheck(
  database: DatabaseSync,
  databaseLabel: string,
  pragma: SqliteCheckPragma,
  tableName?: string,
): "ok" {
  const argument = tableName ? `('${tableName.replaceAll("'", "''")}')` : "";
  let rows: Array<Record<string, unknown>>;
  try {
    rows = database.prepare(`PRAGMA ${pragma}${argument};`).all() as Array<Record<string, unknown>>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createSqliteIntegrityError(
      `SQLite ${pragma} failed for ${databaseLabel}: ${message}`,
      error,
    );
  }
  const results = rows.map((row) => row[pragma] ?? Object.values(row)[0]);
  if (results.length === 1 && results[0] === "ok") {
    return "ok";
  }
  const details = results.map((result) => String(result)).join("; ") || "no result";
  throw createSqliteIntegrityError(`SQLite ${pragma} failed for ${databaseLabel}: ${details}`);
}

function runSqliteForeignKeyCheck(database: DatabaseSync, databaseLabel: string): void {
  let violationCount = 0;
  let repairable = true;
  let taskDeliveryForeignKeyId: bigint | undefined;
  const violations: SqliteForeignKeyViolation[] = [];
  try {
    // Use direct PRAGMA syntax because a real schema object can shadow the
    // table-valued pragma name and make a corrupt database appear clean.
    const statement = database.prepare("PRAGMA foreign_key_check;");
    statement.setReadBigInts(true);
    // OpenClaw's Node >=24.16.0 floor includes iterate(), added in Node 22.13.
    for (const violation of statement.iterate() as Iterable<SqliteForeignKeyViolation>) {
      violationCount += 1;
      retainSortedForeignKeyViolation(violations, violation);
      if (repairable) {
        if (violation.table === "task_delivery_state" && violation.parent === "task_runs") {
          taskDeliveryForeignKeyId ??= readTaskDeliveryCascadeForeignKeyId(database);
          repairable = violation.fkid === taskDeliveryForeignKeyId;
        } else {
          repairable = false;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createSqliteIntegrityError(
      `SQLite foreign_key_check failed for ${databaseLabel}: ${message}`,
      error,
    );
  }
  if (violations.length === 0) {
    return;
  }
  if (repairable) {
    throw new SqliteRepairableForeignKeyError(databaseLabel, violationCount);
  }

  const details = violations.map(formatSqliteForeignKeyViolation);
  if (violationCount > MAX_REPORTED_FOREIGN_KEY_VIOLATIONS) {
    details.push("additional violations omitted");
  }
  throw createSqliteIntegrityError(
    `SQLite foreign_key_check failed for ${databaseLabel}: ${details.join("; ")}`,
  );
}

function readTaskDeliveryCascadeForeignKeyId(database: DatabaseSync): bigint | undefined {
  const statement = database.prepare("PRAGMA foreign_key_list(task_delivery_state);");
  statement.setReadBigInts(true);
  const foreignKeys = statement.all();
  const taskKey = foreignKeys.find(
    (key) =>
      key.table === "task_runs" &&
      key.from === "task_id" &&
      key.to === "task_id" &&
      key.on_delete === "CASCADE",
  );
  // A matching component of a composite foreign key is not the task-owned relation.
  return taskKey &&
    typeof taskKey.id === "bigint" &&
    foreignKeys.filter((key) => key.id === taskKey.id).length === 1
    ? taskKey.id
    : undefined;
}

function createSqliteIntegrityError(message: string, cause?: unknown): Error {
  const error =
    cause === undefined
      ? new Error(
          `${message}. Stop the Gateway, run "openclaw doctor --fix" to inspect and repair this database, and restart. Only if Doctor still cannot repair the offline database, preserve the database and WAL and restore a verified backup.`,
        )
      : new Error(message, { cause });
  error.name = "SqliteIntegrityError";
  return error;
}

function retainSortedForeignKeyViolation(
  retained: SqliteForeignKeyViolation[],
  violation: SqliteForeignKeyViolation,
): void {
  retained.push(violation);
  retained.sort(compareSqliteForeignKeyViolations);
  if (retained.length > MAX_REPORTED_FOREIGN_KEY_VIOLATIONS) {
    retained.pop();
  }
}

function compareSqliteForeignKeyViolations(
  left: SqliteForeignKeyViolation,
  right: SqliteForeignKeyViolation,
): number {
  const tableOrder = Buffer.compare(Buffer.from(left.table), Buffer.from(right.table));
  if (tableOrder !== 0) {
    return tableOrder;
  }
  if (left.rowid === null || right.rowid === null) {
    if (left.rowid !== right.rowid) {
      return left.rowid === null ? -1 : 1;
    }
  } else if (left.rowid !== right.rowid) {
    return left.rowid < right.rowid ? -1 : 1;
  }
  const parentOrder = Buffer.compare(Buffer.from(left.parent), Buffer.from(right.parent));
  if (parentOrder !== 0) {
    return parentOrder;
  }
  if (left.fkid === right.fkid) {
    return 0;
  }
  return left.fkid < right.fkid ? -1 : 1;
}

function formatSqliteForeignKeyViolation(violation: SqliteForeignKeyViolation): string {
  const row = violation.rowid === null ? "row without rowid" : `row ${violation.rowid.toString()}`;
  return `${violation.table} ${row} references ${violation.parent} (foreign key ${violation.fkid.toString()})`;
}
