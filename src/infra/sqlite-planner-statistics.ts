import type { DatabaseSync } from "node:sqlite";
import { captureSqliteNativeRuntimeAdmission } from "./node-sqlite.js";
import { compareValidSemver } from "./semver.js";

const OPTIMIZE_ALL_TABLES_SQLITE_VERSION = "3.46.0";
// From 3.51.0 the row estimate counts each interior page's children (cells + 1).
const ROW_ESTIMATE_COUNTS_CHILDREN_SQLITE_VERSION = "3.51.0";
// SQLite's `PRAGMA optimize` reanalyzes a table whose estimated row count left a
// 10x band (LogEst +/-33) around its recorded count; LogEst(1048576) is a fresh table's estimate.
const OPTIMIZE_SIZE_RANGE = 33;
const DEFAULT_TABLE_ROW_LOG_EST = 200;

function runtimeIsAtLeast(minimum: string): boolean {
  const version = captureSqliteNativeRuntimeAdmission()?.version;
  return !version || (compareValidSemver(version, minimum) ?? 0) >= 0;
}

function hasOptimizeAllTables(): boolean {
  return runtimeIsAtLeast(OPTIMIZE_ALL_TABLES_SQLITE_VERSION);
}

/** The caller owns writer admission; sampling is bounded per index, not by elapsed time. */
export function refreshSqlitePlannerStatistics(database: DatabaseSync): void {
  if (!hasOptimizeAllTables()) {
    // The supported SQLite 3.44 line lacks optimize's all-table mask;
    // analyze explicitly with the same per-index sampling bound.
    database.exec("PRAGMA analysis_limit=1000; ANALYZE main;"); // sqlite-allow-raw -- SQLite-owned planner statistics.
    return;
  }
  // Include tables this maintenance connection has not queried; SQLite only
  // analyzes missing or stale statistics instead of refreshing the whole store.
  database.exec("PRAGMA analysis_limit=1000; PRAGMA optimize=0x10002;"); // sqlite-allow-raw -- SQLite-owned planner statistics.
}

/** SQLite's sqlite3LogEst: about 10*log2(x), with LogEst(1) = 0. */
function sqliteLogEst(value: number): number {
  const fractions = [0, 2, 3, 5, 6, 7, 8, 9];
  let x = value;
  let y = 40;
  if (x < 8) {
    if (x < 2) {
      return 0;
    }
    while (x < 8) {
      y -= 10;
      x *= 2;
    }
  } else {
    while (x > 255) {
      y += 40;
      x = Math.floor(x / 16);
    }
    while (x > 15) {
      y += 10;
      x = Math.floor(x / 2);
    }
  }
  return fractions[x & 7]! + y - 10;
}

/**
 * The row estimate SQLite's optimize compares (sqlite3BtreeRowCountEst): the leftmost
 * leaf's cells times each interior page's fanout on the path to it, or -1 when empty.
 */
function readTableRowLogEst(database: DatabaseSync, table: string): number {
  const childCount = runtimeIsAtLeast(ROW_ESTIMATE_COUNTS_CHILDREN_SQLITE_VERSION) ? 1 : 0;
  // dbstat walks pages depth-first, so the leftmost path ends at the first leaf row.
  const pages = database // sqlite-allow-raw -- Read-only planner estimate.
    .prepare("SELECT pagetype, ncell FROM dbstat WHERE name = ? AND aggregate = FALSE")
    // SAFETY: dbstat declares pagetype as TEXT and ncell as INTEGER for every row.
    .iterate(table) as Iterable<{ pagetype: string; ncell: number }>;
  let estimate = 1;
  for (const page of pages) {
    if (page.pagetype === "overflow") {
      continue;
    }
    if (page.pagetype === "leaf") {
      estimate *= page.ncell;
      return estimate === 0 ? -1 : sqliteLogEst(estimate);
    }
    estimate *= page.ncell + childCount;
  }
  return -1;
}

/**
 * Read-only: whether `refreshSqlitePlannerStatistics` would change `sqlite_stat1`.
 *
 * SQLite cannot answer this itself on a read-only connection: debug-mode optimize
 * still requests a write transaction once two tables need its size check. This
 * applies the same per-table rule to the committed catalog: an indexed table with
 * an unanalyzed index, or a table whose row estimate left the 10x band around its
 * recorded count, is reanalyzed. Empty tables only change when they still carry rows.
 */
export function sqlitePlannerStatisticsNeedRefresh(database: DatabaseSync): boolean {
  if (!hasOptimizeAllTables()) {
    return true;
  }
  const hasStatTable = Boolean(
    database // sqlite-allow-raw -- Read-only catalog inspection.
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'")
      .get(),
  );
  const statRows = hasStatTable
    ? (database // sqlite-allow-raw -- Read-only planner statistics inspection.
        .prepare("SELECT tbl, idx, stat FROM sqlite_stat1")
        // SAFETY: sqlite_stat1 has exactly these columns; idx and stat may be NULL.
        .all() as Array<{ tbl: string; idx: string | null; stat: string | null }>)
    : [];
  const tables = database // sqlite-allow-raw -- Read-only catalog inspection.
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql NOT LIKE 'CREATE VIRTUAL %'",
    )
    // SAFETY: sqlite_schema.name is TEXT and never NULL for a table row.
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const withoutRowid = Boolean(
      database // sqlite-allow-raw -- Read-only catalog inspection.
        .prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?")
        .get(name)?.wr,
    );
    // ANALYZE records a WITHOUT ROWID table's primary key under the table's own name.
    const indexes = (
      database // sqlite-allow-raw -- Read-only catalog inspection.
        .prepare("SELECT name, origin, partial FROM pragma_index_list(?)")
        // SAFETY: pragma_index_list returns TEXT name/origin and INTEGER partial.
        .all(name) as Array<{ name: string; origin: string; partial: number }>
    ).map((index) => ({
      name: withoutRowid && index.origin === "pk" ? name : index.name,
      partial: index.partial,
    }));
    const rows = statRows.filter((row) => row.tbl === name);
    const size = readTableRowLogEst(database, name);
    // ANALYZE rewrites a table with rows; on an empty table it only deletes earlier rows.
    // The first ANALYZE also creates sqlite_stat1 itself.
    const analysisChanges = size >= 0 || rows.length > 0 || !hasStatTable;
    const analyzed = new Set(rows.map((row) => row.idx));
    if (indexes.some((index) => !analyzed.has(index.name))) {
      // An index without statistics analyzes a table with rows; an empty one is skipped.
      if (size >= 0) {
        return true;
      }
      continue;
    }
    // SQLite loads stat1 in row order and keeps the last table estimate: from the table's
    // own row, a full-table index row, or a row naming no current index.
    const recorded = rows.findLast(
      (row) => !indexes.some((index) => index.name === row.idx && index.partial !== 0),
    );
    const recordedRows = Number.parseInt(recorded?.stat ?? "", 10);
    const threshold =
      recorded && Number.isSafeInteger(recordedRows)
        ? sqliteLogEst(recordedRows)
        : DEFAULT_TABLE_ROW_LOG_EST;
    // A small recorded count also accepts an empty table (-1).
    const lower = threshold < OPTIMIZE_SIZE_RANGE ? -1 : threshold - OPTIMIZE_SIZE_RANGE;
    if ((size < lower || size > threshold + OPTIMIZE_SIZE_RANGE) && analysisChanges) {
      return true;
    }
  }
  return false;
}
