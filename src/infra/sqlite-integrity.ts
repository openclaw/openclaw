import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { recordSqliteDatabaseIntegrity } from "./sqlite-database-admission.js";
import { isSqliteCorruptionError } from "./sqlite-error-diagnostics.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "./sqlite-file-generation.js";
import { captureSqliteSchemaFacts } from "./sqlite-schema-admission.js";
import { findSqlClosingParenthesis, normalizeSchemaSql } from "./sqlite-schema-sql.js";

export type SqliteIntegrityCheckOptions = { allFindings?: boolean; ftsSchemas?: readonly string[] };

type SqliteIntegrityChecks = {
  integrityCheck: "ok";
};

export type SqliteIntegrityCheckTiming = {
  syncElapsedMs?: number;
  workerCheckElapsedMs?: number;
  workerLifetimeElapsedMs?: number;
};

export type SqliteIntegrityCheck = {
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
  integrityGateMode?: "full" | "deferred";
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
): SqliteIntegrityOperation<void> {
  const startedAt = performance.now();
  const check: SqliteIntegrityCheck = { database, databaseLabel };
  if (diagnostics) {
    check.timing = {};
    diagnostics.integrityGateMode = "full";
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
    assertSqliteIntegrity(check.database, check.databaseLabel);
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
  repairIntegrityError?: (check: SqliteIntegrityCheck, error: unknown) => boolean,
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
    if (failure && repairIntegrityError) {
      const original = failure.error;
      try {
        if (repairIntegrityError(step.value, original)) {
          failure = undefined;
        }
      } catch (repairError) {
        // Keep the original corruption verdict so failed repair retains quarantine policy.
        if (original instanceof Error) {
          original.message += ` Startup FTS repair failed: ${String(repairError)}`;
        }
      }
    }
    step = failure ? operation.throw(failure.error) : operation.next();
  }
  return step.value;
}

type UnboundSqliteIntegrityConfirmation =
  | { status: "failed"; error: Error; terminal: boolean }
  | { status: "healthy" };

export type SqliteIntegrityConfirmation =
  | { status: "failed"; error: Error; terminal: false }
  | { status: "failed"; error: Error; generation: SqliteFileGeneration; terminal: true }
  | { status: "healthy"; generation: SqliteFileGeneration };

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

/** Require structural, table/index, and referential consistency before trusting a database. */
export function assertSqliteIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
  options: SqliteCheckPragma | SqliteIntegrityCheckOptions = "integrity_check",
): SqliteIntegrityChecks {
  const check = typeof options === "string" ? options : "integrity_check";
  const settings = typeof options === "object" ? options : {};
  let staleFts = false;
  try {
    runSqliteCheck(
      database,
      databaseLabel,
      check,
      undefined,
      settings.allFindings || settings.ftsSchemas !== undefined,
    );
  } catch (error) {
    if (
      !settings.ftsSchemas ||
      !(error instanceof SqliteIntegrityError) ||
      !error.findings ||
      !classifySqliteFtsIntegrityFindings(database, error.findings, settings.ftsSchemas)
    ) {
      throw error;
    }
    staleFts = true;
  }
  runSqliteForeignKeyCheck(database, databaseLabel);
  if (check === "integrity_check" && !staleFts) {
    recordSqliteDatabaseIntegrity(database);
  }
  return { integrityCheck: "ok" };
}

/** Only exact, owned FTS definitions may treat their inverted index as derived data. */
export function classifySqliteFtsIntegrityFindings(
  database: DatabaseSync,
  findings: readonly unknown[],
  schemas: readonly string[],
): string[] | undefined {
  const names = new Set<string>();
  for (const finding of findings) {
    if (finding === "ok") {
      continue;
    }
    const match =
      typeof finding === "string"
        ? /^malformed inverted index for FTS5 table main\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(finding)
        : null;
    if (!match?.[1]) {
      return undefined;
    }
    names.add(match[1]);
  }
  if (names.size === 0) {
    return undefined;
  }
  const definitions = new Map<string, Set<string | null>>();
  for (const schema of schemas) {
    for (const match of schema.matchAll(
      /CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?([A-Za-z_][A-Za-z0-9_]*) USING fts5\s*\(/gu,
    )) {
      const name = match[1]!;
      const end = findSqlClosingParenthesis(schema, match.index + match[0].length - 1);
      const variants = definitions.get(name) ?? new Set<string | null>();
      variants.add(normalizeSchemaSql(schema.slice(match.index, end + 1)));
      definitions.set(name, variants);
    }
  }
  const tables = captureSqliteSchemaFacts(database).tableSql;
  for (const name of names) {
    const sql = tables.get(name);
    if (typeof sql !== "string" || !definitions.get(name)?.has(normalizeSchemaSql(sql))) {
      return undefined;
    }
  }
  return [...names].toSorted();
}

/** Reconfirm an advisory failure against the database currently at a closed path. */
export function confirmSqliteFileIntegrity(
  pathname: string,
  databaseLabel: string,
): SqliteIntegrityConfirmation {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let initial: SqliteFileGeneration;
    let database: DatabaseSync;
    try {
      initial = readStableSqliteFileGeneration(pathname);
      database = openNodeSqliteDatabase(pathname, { readOnly: true });
    } catch (error) {
      // A failed SQLite open exposes no descriptor identity. Path snapshots
      // cannot bind the error safely across an A -> B -> A file rotation.
      return unboundSqliteIntegrityFailure(error);
    }

    let opened: SqliteFileGeneration | undefined;
    try {
      opened = readStableSqliteFileGeneration(pathname);
    } catch {
      // A missing generation follows the same native cleanup as a changed one.
    }
    if (!opened || !sameSqliteFileGeneration(initial, opened)) {
      const closeError = closeSqliteDatabase(database);
      if (closeError) {
        return unboundSqliteIntegrityFailure(closeError);
      }
      continue;
    }

    let confirmation: UnboundSqliteIntegrityConfirmation;
    try {
      assertSqliteIntegrity(database, databaseLabel);
      confirmation = { status: "healthy" };
    } catch (error) {
      confirmation = failedSqliteIntegrityConfirmation(error);
    }
    const closeError = closeSqliteDatabase(database);
    if (closeError && confirmation.status === "healthy") {
      confirmation = failedSqliteIntegrityConfirmation(closeError);
    }

    let final: SqliteFileGeneration;
    try {
      final = readStableSqliteFileGeneration(pathname);
    } catch {
      continue;
    }
    if (!sameSqliteFileGeneration(opened, final)) {
      continue;
    }
    if (confirmation.status === "healthy") {
      return { status: "healthy", generation: final };
    }
    return confirmation.terminal
      ? { ...confirmation, generation: final, terminal: true }
      : { ...confirmation, terminal: false };
  }
  return unboundSqliteIntegrityFailure(
    new Error(`SQLite file generation did not stabilize during confirmation: ${pathname}`),
  );
}

function failedSqliteIntegrityConfirmation(error: unknown): UnboundSqliteIntegrityConfirmation {
  const normalized = toStringifiedError(error);
  return {
    status: "failed",
    error: normalized,
    terminal: isTerminalSqliteIntegrityError(normalized),
  };
}

function unboundSqliteIntegrityFailure(error: unknown): SqliteIntegrityConfirmation {
  const normalized = toStringifiedError(error);
  return { status: "failed", error: normalized, terminal: false };
}

function closeSqliteDatabase(database: DatabaseSync): Error | undefined {
  try {
    database.close();
    return undefined;
  } catch (error) {
    return toStringifiedError(error);
  }
}

/** Require table and associated index consistency before trusting indexed reads. */
export function assertSqliteTableIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
  tableName: string,
): void {
  runSqliteCheck(database, `${databaseLabel} table ${tableName}`, "integrity_check", tableName);
}

/** Maintenance must see every finding before deciding that only derived indexes need repair. */
export function readSqliteIntegrityFindings(database: DatabaseSync): unknown[] {
  return readSqliteCheckFindings(database, "integrity_check", undefined, true);
}

function readSqliteCheckFindings(
  database: DatabaseSync,
  pragma: SqliteCheckPragma,
  tableName?: string,
  allFindings = false,
): unknown[] {
  const argument = tableName
    ? `('${tableName.replaceAll("'", "''")}')`
    : allFindings
      ? "(2147483647)"
      : "";
  const rows = database.prepare(`PRAGMA ${pragma}${argument};`).all();
  return rows.map((row) => row[pragma] ?? Object.values(row)[0]);
}

function runSqliteCheck(
  database: DatabaseSync,
  databaseLabel: string,
  pragma: SqliteCheckPragma,
  tableName?: string,
  allFindings = false,
): "ok" {
  let results: unknown[];
  try {
    results = readSqliteCheckFindings(database, pragma, tableName, allFindings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SqliteIntegrityError(
      `SQLite ${pragma} failed for ${databaseLabel}: ${message}`,
      error,
    );
  }
  if (results.length === 1 && results[0] === "ok") {
    return "ok";
  }
  const details = results.map((result) => String(result)).join("; ") || "no result";
  throw new SqliteIntegrityError(
    `SQLite ${pragma} failed for ${databaseLabel}: ${details}`,
    undefined,
    results,
  );
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
    throw new SqliteIntegrityError(
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
  throw new SqliteIntegrityError(
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

export class SqliteIntegrityError extends Error {
  constructor(
    message: string,
    cause?: unknown,
    readonly findings?: readonly unknown[],
  ) {
    super(
      cause === undefined
        ? `${message}. Stop the Gateway, run "openclaw doctor --fix" to inspect and repair this database, and restart. Only if Doctor still cannot repair the offline database, preserve the database and WAL and restore a verified backup.`
        : message,
      cause === undefined ? undefined : { cause },
    );
    this.name = "SqliteIntegrityError";
  }
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
