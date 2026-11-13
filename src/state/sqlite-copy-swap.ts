// Generic name-matched rebuild of one SQLite file: the copy-and-swap fallback.
//
// The source is opened read-only and never written. A new file is built from the
// current schema and rows are copied table by table. Rows that do not fit are set
// aside, never dropped. state-upgrade.ts owns when this runs and the swap.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { castValue, jsonRow } from "./sqlite-copy-swap-values.js";
import {
  fsyncPath,
  normalizeSqliteText,
  readSqliteRows,
  vacuumSqliteInto,
} from "./state-upgrade-tree.js";

/** Meaning changes that a name-matched copy cannot express. Keep it small. */
export type SqliteSwapMap = {
  /** Old table name -> new table name. */
  tables?: Readonly<Record<string, string>>;
  /** `table.old_column` -> new column name (table is the new table name). */
  columns?: Readonly<Record<string, string>>;
  /** Tables or `table.column` whose data is deliberately dropped, with the reason. */
  retired?: Readonly<Record<string, string>>;
  /** Current tables rebuilt from other rows; never copied. */
  derived?: ReadonlySet<string>;
  /** Leases, locks and in-flight attempts; never copied. */
  ephemeral?: ReadonlySet<string>;
  /** Fill a new NOT NULL column that has no default: `table.column` -> SQL over source columns. */
  backfill?: Readonly<Record<string, string>>;
  /** Renamed enum values: `table.column` (new names) -> old value -> new value. */
  values?: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

export type SqliteSwapTarget = {
  /** Diagnostic label, for example `state` or `agent:main`. */
  label: string;
  /** Schema version written to `PRAGMA user_version`. */
  version: number;
  /** Install the complete current schema, plus first-use tables the source already has. */
  createSchema: (db: DatabaseSync, sourceTables: ReadonlySet<string>) => void;
  /** Write current schema metadata rows after the copy. */
  stamp: (db: DatabaseSync) => void;
  /** Rebuild derived tables after the copy. */
  rebuild?: (db: DatabaseSync) => void;
  map: SqliteSwapMap;
};

export type SetAsideRow = {
  table: string;
  reason: string;
  row: Record<string, unknown>;
};

export type SqliteSwapTableReport = {
  table: string;
  target: string;
  source: number;
  copied: number;
  setAside: number;
};

export type SqliteSwapReport = {
  label: string;
  fromVersion: number;
  toVersion: number;
  tables: SqliteSwapTableReport[];
  setAside: SetAsideRow[];
  /** Tables where source rows != copied + set aside. The old file is pinned. */
  conservationMismatches: string[];
  droppedTables: string[];
  droppedColumns: string[];
};

type Column = {
  name: string;
  type: string;
  notNull: boolean;
  defaultSql: string | null;
  pk: number;
};

type TableInfo = {
  name: string;
  type: "table" | "virtual" | "shadow" | "view";
  withoutRowid: boolean;
  strict: boolean;
  columns: Column[];
};

const SET_ASIDE_SCOPE = "upgrade.set-aside";
const MAX_FK_PASSES = 8;
const RECENCY_COLUMNS = [
  "updated_at_ms",
  "updated_at",
  "updated_time",
  "last_updated_at_ms",
  "last_updated_at",
  "created_at_ms",
  "created_at",
  "created_time",
];

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function readTables(db: DatabaseSync): Map<string, TableInfo> {
  const tables = new Map<string, TableInfo>();
  // SAFETY: the statement fixes the column names and types of each row.
  const rows = db.prepare("PRAGMA main.table_list").all() as Array<{
    name: string;
    type: TableInfo["type"];
    wr: number;
    strict: number;
  }>;
  for (const row of rows) {
    if (row.name.startsWith("sqlite_")) {
      continue;
    }
    const columns =
      row.type === "shadow"
        ? []
        : readSqliteRows<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
            hidden: number;
          }>(db, `PRAGMA main.table_xinfo(${quote(row.name)})`)
            // Generated and virtual-table hidden columns are not stored values.
            .filter((column) => column.hidden === 0)
            .map((column) => ({
              name: column.name,
              type: column.type.toUpperCase(),
              notNull: column.notnull === 1,
              defaultSql: column.dflt_value,
              pk: column.pk,
            }));
    tables.set(row.name, {
      name: row.name,
      type: row.type,
      withoutRowid: row.wr === 1,
      strict: row.strict === 1,
      columns,
    });
  }
  return tables;
}

function readUserVersion(db: DatabaseSync): number {
  return readSqliteUserVersion(db);
}

type Source = { db: DatabaseSync; close: () => void };

/**
 * Open the old file without writing it. A hot rollback journal needs a writer to
 * roll back, so that case reads a private copy instead.
 */
function openSource(pathname: string): Source {
  let readPath = pathname;
  let scratchDir: string | undefined;
  if (fs.existsSync(`${pathname}-journal`) && fs.statSync(`${pathname}-journal`).size > 0) {
    scratchDir = fs.mkdtempSync(path.join(path.dirname(pathname), ".swap-src-"));
    readPath = path.join(scratchDir, path.basename(pathname));
    fs.copyFileSync(pathname, readPath);
    fs.copyFileSync(`${pathname}-journal`, `${readPath}-journal`);
  }
  const db = openNodeSqliteDatabase(readPath, { readOnly: !scratchDir });
  db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
  return {
    db,
    close: () => {
      db.close();
      if (scratchDir) {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      }
    },
  };
}

type UniqueKey = string[];

function readUniqueKeys(db: DatabaseSync, table: TableInfo): UniqueKey[] {
  const keys: UniqueKey[] = [];
  const pk = table.columns
    .filter((column) => column.pk > 0)
    .toSorted((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  if (pk.length > 0) {
    keys.push(pk);
  }
  // SAFETY: the statement fixes the column names and types of each row.
  const indexes = db.prepare(`PRAGMA main.index_list(${quote(table.name)})`).all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  for (const index of indexes) {
    if (index.unique !== 1 || index.partial === 1) {
      continue;
    }
    const columns = readSqliteRows<{ name: string | null }>(
      db,
      `PRAGMA main.index_info(${quote(index.name)})`,
    ).map((column) => column.name);
    // Expression indexes cannot be matched by column values.
    if (columns.every((name): name is string => name !== null)) {
      keys.push(columns);
    }
  }
  return keys;
}

function isConstraintError(error: unknown): error is Error & { errcode: number } {
  const errcode: unknown = error instanceof Error ? Reflect.get(error, "errcode") : undefined;
  return typeof errcode === "number" && (errcode & 0xff) === 19;
}

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_ROWID = 2579;

type CopyContext = {
  source: DatabaseSync;
  target: DatabaseSync;
  map: SqliteSwapMap;
  setAside: SetAsideRow[];
};

function copyTable(
  context: CopyContext,
  sourceTable: TableInfo,
  targetTable: TableInfo,
  droppedColumns: string[],
): SqliteSwapTableReport {
  const { source, target, map } = context;
  const sourceColumns = new Set(sourceTable.columns.map((column) => column.name));
  const renamed = (column: string) => {
    for (const [from, to] of Object.entries(map.columns ?? {})) {
      const [table, name] = from.split(".");
      if (table === targetTable.name && to === column && name && sourceColumns.has(name)) {
        return name;
      }
    }
    return sourceColumns.has(column) ? column : undefined;
  };
  const plan = targetTable.columns.flatMap((column) => {
    const from = renamed(column.name);
    const backfill = map.backfill?.[`${targetTable.name}.${column.name}`];
    if (from === undefined && backfill === undefined) {
      return [];
    }
    return [{ column, from, backfill }];
  });
  const used = new Set(plan.flatMap((entry) => (entry.from ? [entry.from] : [])));
  for (const column of sourceTable.columns) {
    if (!used.has(column.name)) {
      droppedColumns.push(`${sourceTable.name}.${column.name}`);
    }
  }
  const targetPk = targetTable.columns.filter((column) => column.pk > 0);
  const integerPrimaryKey = targetPk.length === 1 && targetPk[0]?.type === "INTEGER";
  // Rowids can be referenced by external-content indexes; an INTEGER PRIMARY KEY already is one.
  const keepRowid =
    sourceTable.type === "table" &&
    !sourceTable.withoutRowid &&
    targetTable.type === "table" &&
    !targetTable.withoutRowid &&
    !integerPrimaryKey;
  const selectParts = [
    ...(keepRowid ? ["rowid AS swaprowid"] : []),
    ...plan.map((entry, index) =>
      entry.from !== undefined
        ? `${quote(entry.from)} AS swapc${index}`
        : `(${entry.backfill}) AS swapc${index}`,
    ),
    // Set-aside rows keep every original column, including dropped ones.
    ...sourceTable.columns.map((column, index) => `${quote(column.name)} AS swapo${index}`),
  ];
  const select = source.prepare(
    `SELECT ${selectParts.join(", ")} FROM ${quote(sourceTable.name)}${keepRowid ? " ORDER BY rowid" : ""}`,
  );
  select.setReadBigInts(true);
  const insertColumns = [...(keepRowid ? ["rowid"] : []), ...plan.map((e) => e.column.name)];
  const insertValues = [
    ...(keepRowid ? ["?"] : []),
    ...plan.map(({ column }) =>
      column.notNull && column.defaultSql !== null ? `COALESCE(?, (${column.defaultSql}))` : "?",
    ),
  ];
  const insert = target.prepare(
    `INSERT INTO ${quote(targetTable.name)} (${insertColumns.map(quote).join(", ")}) VALUES (${insertValues.join(", ")})`,
  );
  const uniqueKeys = readUniqueKeys(target, targetTable);
  const recency = RECENCY_COLUMNS.find((name) =>
    targetTable.columns.some((column) => column.name === name),
  );
  let sourceCount = 0;
  let copied = 0;
  let setAside = 0;
  const original = (row: Record<string, SQLOutputValue>) => {
    const values: Record<string, SQLOutputValue> = {};
    sourceTable.columns.forEach((column, index) => {
      values[column.name] = row[`swapo${index}`] ?? null;
    });
    return values;
  };
  const putAside = (reason: string, row: Record<string, SQLOutputValue>) => {
    context.setAside.push({ table: sourceTable.name, reason, row: jsonRow(row) });
    setAside += 1;
  };
  // SAFETY: the statement fixes the column names and types of each row.
  for (const row of select.iterate() as IterableIterator<Record<string, SQLOutputValue>>) {
    sourceCount += 1;
    const values: SQLInputValue[] = keepRowid ? [row.swaprowid ?? null] : [];
    let castFailure: string | undefined;
    plan.forEach(({ column }, index) => {
      const raw = row[`swapc${index}`] ?? null;
      const renamedValue =
        typeof raw === "string"
          ? map.values?.[`${targetTable.name}.${column.name}`]?.[raw]
          : undefined;
      const cast = castValue(renamedValue ?? raw, column.type);
      if (!cast.ok) {
        castFailure ??= `${column.name} cannot be stored as ${column.type}`;
        values.push(null);
        return;
      }
      values.push(cast.value);
    });
    if (castFailure) {
      putAside(castFailure, original(row));
      continue;
    }
    try {
      insert.run(...values);
      copied += 1;
    } catch (error) {
      if (!isConstraintError(error)) {
        throw error;
      }
      const code = error.errcode;
      if (
        code !== SQLITE_CONSTRAINT_PRIMARYKEY &&
        code !== SQLITE_CONSTRAINT_UNIQUE &&
        code !== SQLITE_CONSTRAINT_ROWID
      ) {
        putAside(error.message, original(row));
        continue;
      }
      // Two old rows normalized to one key: keep the most recently updated one.
      const incoming = new Map(insertColumns.map((name, index) => [name, values[index] ?? null]));
      const existing = findCollision(target, targetTable, uniqueKeys, incoming, keepRowid);
      const incomingNewer =
        existing !== undefined &&
        recency !== undefined &&
        compareRecency(incoming.get(recency), existing.row[recency]) > 0;
      if (!existing || !incomingNewer) {
        putAside(`key collision: ${error.message}`, original(row));
        continue;
      }
      try {
        target
          .prepare(
            keepRowid || !targetTable.withoutRowid
              ? `DELETE FROM ${quote(targetTable.name)} WHERE rowid = ?`
              : `DELETE FROM ${quote(targetTable.name)} WHERE ${existing.key.map((c) => `${quote(c)} IS ?`).join(" AND ")}`,
          )
          .run(
            ...(keepRowid || !targetTable.withoutRowid
              ? [existing.row.swaprowid ?? null]
              : existing.key.map((c) => existing.row[c] ?? null)),
          );
        insert.run(...values);
        const displaced = { ...existing.row };
        delete displaced.swaprowid;
        putAside(`key collision: replaced by a newer row`, displaced);
        // The displaced row was counted as copied; the incoming one replaces it.
      } catch (retryError) {
        if (!isConstraintError(retryError)) {
          throw retryError;
        }
        putAside(`key collision: ${retryError.message}`, original(row));
      }
    }
  }
  return {
    table: sourceTable.name,
    target: targetTable.name,
    source: sourceCount,
    copied,
    setAside,
  };
}

function compareRecency(a: unknown, b: unknown): number {
  const toNumber = (value: unknown) =>
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value) || Number(value) || 0
          : 0;
  return toNumber(a) - toNumber(b);
}

function findCollision(
  db: DatabaseSync,
  table: TableInfo,
  keys: UniqueKey[],
  incoming: Map<string, SQLInputValue>,
  keepRowid: boolean,
): { key: string[]; row: Record<string, SQLOutputValue> } | undefined {
  const candidates = keepRowid ? [["rowid"], ...keys] : keys;
  for (const key of candidates) {
    if (!key.every((column) => incoming.has(column))) {
      continue;
    }
    const rowidSelect = table.withoutRowid ? "" : "rowid AS swaprowid, ";
    const statement = db.prepare(
      `SELECT ${rowidSelect}* FROM ${quote(table.name)} WHERE ${key.map((c) => `${quote(c)} IS ?`).join(" AND ")} LIMIT 1`,
    );
    statement.setReadBigInts(true);
    // SAFETY: SELECT * returns one value per column of this table.
    const row = statement.get(...key.map((column) => incoming.get(column) ?? null)) as
      | Record<string, SQLOutputValue>
      | undefined;
    if (row) {
      return { key, row };
    }
  }
  return undefined;
}

/** Remove rows that point at missing parents; foreign keys are off during the copy. */
function setAsideForeignKeyViolations(
  db: DatabaseSync,
  tables: Map<string, TableInfo>,
  reports: Map<string, SqliteSwapTableReport>,
  setAside: SetAsideRow[],
): void {
  for (let pass = 0; pass < MAX_FK_PASSES; pass += 1) {
    // SAFETY: the statement fixes the column names and types of each row.
    const violations = db.prepare("PRAGMA main.foreign_key_check").all() as Array<{
      table: string;
      rowid: number | bigint | null;
      parent: string;
    }>;
    if (violations.length === 0) {
      return;
    }
    let removed = 0;
    for (const violation of violations) {
      if (violation.rowid === null || !tables.get(violation.table)) {
        continue;
      }
      const statement = db.prepare(`SELECT * FROM ${quote(violation.table)} WHERE rowid = ?`);
      statement.setReadBigInts(true);
      // SAFETY: the statement fixes the column names and types of each row.
      const row = statement.get(violation.rowid) as Record<string, SQLOutputValue> | undefined;
      if (!row) {
        continue;
      }
      db.prepare(`DELETE FROM ${quote(violation.table)} WHERE rowid = ?`).run(violation.rowid);
      removed += 1;
      const report = [...reports.values()].find((entry) => entry.target === violation.table);
      setAside.push({
        table: report?.table ?? violation.table,
        reason: `missing ${violation.parent} parent`,
        row: jsonRow(row),
      });
      if (report) {
        report.copied -= 1;
        report.setAside += 1;
      }
    }
    if (removed === 0) {
      return;
    }
  }
}

/** Write set-aside rows into the new file's diagnostic_events table. */
export function insertSetAsideRows(
  db: DatabaseSync,
  report: Pick<SqliteSwapReport, "label" | "fromVersion" | "toVersion"> & { previousFile: string },
  rows: readonly SetAsideRow[],
  now = Date.now(),
): void {
  const insert = db.prepare(
    `INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at, sequence) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, event_key) DO UPDATE SET payload_json = excluded.payload_json,
         created_at = excluded.created_at, sequence = excluded.sequence`,
  );
  rows.forEach((row, index) => {
    insert.run(
      SET_ASIDE_SCOPE,
      `${report.label}:${report.toVersion}:${now}:${index}`,
      JSON.stringify({
        database: report.label,
        previousFile: path.basename(report.previousFile),
        fromVersion: report.fromVersion,
        toVersion: report.toVersion,
        ...row,
      }),
      now,
      index,
    );
  });
}

export const UPGRADE_SET_ASIDE_SCOPE = SET_ASIDE_SCOPE;

/**
 * Build the current schema at `outPath` from a source file that is never written.
 * Data problems never fail the build: rows that do not fit are set aside.
 */
export function buildSqliteByCopy(
  target: SqliteSwapTarget,
  sourcePath: string,
  outPath: string,
): SqliteSwapReport {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    fs.rmSync(`${outPath}${suffix}`, { force: true });
  }
  const source = openSource(sourcePath);
  let built: DatabaseSync | undefined;
  try {
    const fromVersion = readUserVersion(source.db);
    const sourceTables = readTables(source.db);
    built = openNodeSqliteDatabase(outPath);
    built.exec(
      // A crash discards this file, so durability waits for the final fsync. The
      // in-memory journal still undoes a failed statement.
      "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;",
    );
    target.createSchema(
      built,
      new Set([...sourceTables.keys()].map((name) => target.map.tables?.[name] ?? name)),
    );
    // Triggers would rewrite derived rows during the copy; reinstall them after.
    const triggers = built
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL")
      // SAFETY: the statement fixes the column names and types of each row.
      .all() as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) {
      built.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    }
    const targetTables = readTables(built);
    const reports = new Map<string, SqliteSwapTableReport>();
    const setAside: SetAsideRow[] = [];
    const droppedTables: string[] = [];
    const droppedColumns: string[] = [];
    const context: CopyContext = { source: source.db, target: built, map: target.map, setAside };
    const shadowOwners = [...sourceTables.values()]
      .filter((table) => table.type === "virtual")
      .map((table) => `${table.name}_`);
    built.exec("BEGIN");
    for (const sourceTable of sourceTables.values()) {
      if (sourceTable.type === "shadow" || sourceTable.type === "view") {
        continue;
      }
      // Older SQLite libraries list FTS shadow tables as ordinary tables.
      if (shadowOwners.some((prefix) => sourceTable.name.startsWith(prefix))) {
        continue;
      }
      const name = target.map.tables?.[sourceTable.name] ?? sourceTable.name;
      if (target.map.derived?.has(name) || target.map.ephemeral?.has(name)) {
        continue;
      }
      const targetTable = targetTables.get(name);
      if (!targetTable || targetTable.type === "shadow" || targetTable.type === "virtual") {
        droppedTables.push(sourceTable.name);
        if (sourceTable.type === "table" && !target.map.retired?.[sourceTable.name]) {
          // A table this build no longer has keeps its rows as set-aside data.
          reports.set(sourceTable.name, setAsideTable(context, sourceTable));
        }
        continue;
      }
      reports.set(sourceTable.name, copyTable(context, sourceTable, targetTable, droppedColumns));
    }
    setAsideForeignKeyViolations(built, targetTables, reports, setAside);
    built.exec("COMMIT");
    for (const trigger of triggers) {
      built.exec(trigger.sql);
    }
    target.rebuild?.(built);
    built.exec(`PRAGMA user_version = ${target.version}`);
    target.stamp(built);
    const report: SqliteSwapReport = {
      label: target.label,
      fromVersion,
      toVersion: target.version,
      tables: [...reports.values()],
      setAside,
      conservationMismatches: [],
      droppedTables,
      droppedColumns,
    };
    // Conservation: every source row is either in the new table or set aside.
    for (const entry of report.tables) {
      if (entry.source !== entry.copied + entry.setAside) {
        report.conservationMismatches.push(entry.table);
        continue;
      }
      if (entry.target === "") {
        continue;
      }
      const sharedTarget =
        report.tables.filter((other) => other.target === entry.target).length > 1;
      const actual = Number(
        // SAFETY: the statement fixes the column names and types of each row.
        (built.prepare(`SELECT count(*) AS n FROM ${quote(entry.target)}`).get() as { n: number })
          .n,
      );
      if (!sharedTarget && actual < entry.copied) {
        report.conservationMismatches.push(entry.table);
      }
    }
    // SAFETY: the statement fixes the column names and types of each row.
    const integrity = built.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (integrity.quick_check !== "ok") {
      throw new Error(`New ${target.label} database failed quick_check: ${integrity.quick_check}`);
    }
    built.close();
    built = undefined;
    fsyncPath(outPath);
    return report;
  } finally {
    built?.close();
    source.close();
  }
}

function setAsideTable(context: CopyContext, table: TableInfo): SqliteSwapTableReport {
  const select = context.source.prepare(`SELECT * FROM ${quote(table.name)}`);
  select.setReadBigInts(true);
  let count = 0;
  // SAFETY: the statement fixes the column names and types of each row.
  for (const row of select.iterate() as IterableIterator<Record<string, SQLOutputValue>>) {
    count += 1;
    context.setAside.push({ table: table.name, reason: "table removed", row: jsonRow(row) });
  }
  return { table: table.name, target: "", source: count, copied: 0, setAside: count };
}

/** A shipped step that moves rows between tables, run on a private scratch copy. */
export type SqliteFoldInStep = {
  id: string;
  run: (db: DatabaseSync, fromVersion: number) => unknown;
};

/**
 * Run shipped row-moving steps on a private scratch copy, then rebuild from it.
 * A step that throws is rolled back and reported; its rows are set aside instead.
 */
export function buildSqliteWithFoldIns(
  target: SqliteSwapTarget,
  steps: readonly SqliteFoldInStep[],
  sourcePath: string,
  outPath: string,
  scratchDir: string,
): { report: SqliteSwapReport; foldInFailures: string[] } {
  const scratch = path.join(scratchDir, `${path.basename(outPath)}.fold-in`);
  vacuumSqliteInto(sourcePath, scratch);
  const foldInFailures: string[] = [];
  try {
    const db = openNodeSqliteDatabase(scratch);
    try {
      const fromVersion = readUserVersion(db);
      normalizeSqliteText(db);
      for (const step of steps) {
        try {
          db.exec("SAVEPOINT fold_in");
          step.run(db, fromVersion);
          db.exec("RELEASE fold_in");
        } catch (error) {
          db.exec("ROLLBACK TO fold_in; RELEASE fold_in");
          // SAFETY: node:fs and node:sqlite throw Error instances; only optional fields are read.
          foldInFailures.push(`${step.id}: ${(error as Error).message}`);
        }
      }
    } finally {
      db.close();
    }
    return { report: buildSqliteByCopy(target, scratch, outPath), foldInFailures };
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${scratch}${suffix}`, { force: true });
    }
  }
}
