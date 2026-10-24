import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import {
  tableExists,
  tableHasColumn,
  tablePrimaryKeyColumns,
} from "./openclaw-state-db-schema-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "reuses only admitted statements with fresh table names (cache: %s)",
  (cacheEnabled) => {
    using database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE present (id INTEGER); CREATE VIEW projection AS SELECT 1;");
    if (cacheEnabled) {
      enableNodeSqliteKyselyStatementCache(database);
    }
    const prepare = vi.spyOn(database, "prepare");
    const names = ["present", "absent", "projection", "present' OR 1=1 --"];
    for (let repeat = 0; repeat < 8; repeat += 1) {
      expect(names.map((name) => tableExists(database, name))).toEqual([true, false, false, false]);
    }
    expect(prepare).toHaveBeenCalledTimes(cacheEnabled ? 2 : 32);
  },
);

it("observes schema changes within the current WAL read snapshot", () => {
  const filename = path.join(tempDirs.make("openclaw-schema-probe-"), "state.sqlite");
  using reader = new DatabaseSync(filename);
  using writer = new DatabaseSync(filename);
  reader.exec("PRAGMA journal_mode=WAL");
  enableNodeSqliteKyselyStatementCache(reader);
  expect(tableExists(reader, "entries")).toBe(false);
  expect(tableExists(reader, "entries")).toBe(false);
  for (const [db, sql, exists] of [
    [writer, "CREATE TABLE entries (id INTEGER)", true],
    [reader, "BEGIN", true],
    [writer, "DROP TABLE entries", true],
    [reader, "COMMIT", false],
    [reader, "BEGIN; CREATE TABLE entries (id INTEGER)", true],
    [reader, "ROLLBACK", false],
  ] as const) {
    db.exec(sql);
    expect(tableExists(reader, "entries")).toBe(exists);
  }
});

it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
  "rechecks changing authorization after warming the schema probe",
  () => {
    using database = openNodeSqliteDatabase(":memory:");
    database.exec("CREATE TABLE entries (id INTEGER)");
    enableNodeSqliteKyselyStatementCache(database);
    admitSqliteSchema(database);
    for (const probe of [
      () => tableExists(database, "entries"),
      () => tableHasColumn(database, "entries", "id"),
    ]) {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        expect(probe()).toBe(true);
      }
      let allow = false;
      database.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));
      expect(probe).toThrow(/not authorized/iu);
      allow = true;
      expect(probe()).toBe(true);
      allow = false;
      expect(probe).toThrow(/not authorized/iu);
      database.setAuthorizer(null);
      expect(probe()).toBe(true);
    }
  },
);

it("reuses admitted columns without SQL and follows committed or rolled-back DDL", () => {
  using database = openNodeSqliteDatabase(":memory:");
  database.exec(`CREATE TABLE entries (
    -- Keep the same shape as fresh databases.
    id INTEGER, label TEXT DEFAULT 'AS'
  )`);
  admitSqliteSchema(database);
  expect(tableHasColumn(database, "entries", "id")).toBe(true);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  using _ = { [Symbol.dispose]: observation.restore };
  for (let repeat = 0; repeat < 3; repeat += 1) {
    expect(tableHasColumn(database, "entries", "id")).toBe(true);
    expect(tableHasColumn(database, "entries", "missing")).toBe(false);
    expect(tableHasColumn(database, "absent", "id")).toBe(false);
  }
  expect(observation.queries).toEqual([]);
  database.exec("ALTER TABLE entries ADD COLUMN title TEXT");
  expect(tableHasColumn(database, "entries", "title")).toBe(true);
  database.exec("BEGIN; ALTER TABLE entries ADD COLUMN pending TEXT");
  expect(tableHasColumn(database, "entries", "pending")).toBe(true);
  database.exec("ROLLBACK");
  expect(tableHasColumn(database, "entries", "pending")).toBe(false);
  expect(tableHasColumn(database, "entries", "title")).toBe(true);
});

it("reads ordered admitted primary keys without SQL and follows DDL rollback", () => {
  using database = openNodeSqliteDatabase(":memory:");
  database.exec(`CREATE TABLE entries (
    a TEXT DEFAULT 'PRIMARY KEY', b TEXT,
    CONSTRAINT "entry key" PRIMARY KEY (b, b, a)
  )`);
  admitSqliteSchema(database);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  using _ = { [Symbol.dispose]: observation.restore };
  expect(tablePrimaryKeyColumns(database, "entries")).toEqual(["b", "a"]);
  expect(observation.queries).toEqual([]);
  database.exec("BEGIN; DROP TABLE entries; CREATE TABLE entries (a INTEGER PRIMARY KEY)");
  expect(tablePrimaryKeyColumns(database, "entries")).toEqual(["a"]);
  database.exec("ROLLBACK");
  expect(tablePrimaryKeyColumns(database, "entries")).toEqual(["b", "a"]);
  database.exec("DROP TABLE entries; CREATE TABLE entries (a INTEGER)");
  expect(tablePrimaryKeyColumns(database, "entries")).toEqual([]);
});

it.each([
  "CREATE TABLE entries (a TEXT, b TEXT, PRIMARY KEY ((b), a))",
  "CREATE TABLE entries (a TEXT, b TEXT, constraint 'entry key' PRIMARY KEY (b, a))",
])("preserves native primary-key inspection for %s", (sql) => {
  using database = openNodeSqliteDatabase(":memory:");
  database.exec(sql);
  admitSqliteSchema(database);
  expect(tablePrimaryKeyColumns(database, "entries")).toEqual(["b", "a"]);
});

it("preserves native column visibility for generated columns, views, and virtual tables", () => {
  using database = openNodeSqliteDatabase(":memory:");
  database.exec(`
      CREATE TABLE generated (base TEXT, derived TEXT AS /* expression */ (upper(base)));
      CREATE VIEW projected AS SELECT base FROM generated;
      CREATE VIRTUAL TABLE search USING fts5(body);
    `);
  admitSqliteSchema(database);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  using _ = { [Symbol.dispose]: observation.restore };
  expect(tableHasColumn(database, "generated", "base")).toBe(true);
  expect(tableHasColumn(database, "generated", "derived")).toBe(false);
  expect(tableHasColumn(database, "projected", "base")).toBe(true);
  expect(tableHasColumn(database, "search", "body")).toBe(true);
  expect(tableHasColumn(database, "search", "rank")).toBe(false);
  expect(observation.queries).toContain("PRAGMA table_info(generated)");
  expect(observation.queries).toContain("PRAGMA table_info(projected)");
  expect(observation.queries).toContain("PRAGMA table_info(search)");
});
