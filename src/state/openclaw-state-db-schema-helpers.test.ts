import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "../infra/sqlite-schema-facts.test-support.js";
import {
  ensureColumn,
  tableExists,
  tableHasColumn,
  tablePrimaryKeyColumns,
} from "./openclaw-state-db-schema-helpers.js";

const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();

it("distinguishes tables from missing names, views, and injected SQL", () => {
  using database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE present (id INTEGER); CREATE VIEW projection AS SELECT 1;");
  const names = ["present", "absent", "projection", "present' OR 1=1 --"];
  expect(names.map((name) => tableExists(database, name))).toEqual([true, false, false, false]);
});

it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
  "rechecks changing authorization after warming the schema probe",
  () => {
    using database = openNodeSqliteDatabase(":memory:");
    database.exec("CREATE TABLE entries (id INTEGER)");
    enableNodeSqliteKyselyStatementCache(database);
    admitSqliteSchema(database);
    const probe = () => tableHasColumn(database, "entries", "id");
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
  },
);

it("reuses admitted columns and ordered keys without SQL across DDL and rollback", () => {
  using database = openNodeSqliteDatabase(":memory:");
  database.exec(`CREATE TABLE entries (
    id INTEGER, label TEXT DEFAULT 'AS', a TEXT DEFAULT 'PRIMARY KEY', b TEXT,
    CONSTRAINT "entry key" PRIMARY KEY (b, b, a)
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
  expect(tablePrimaryKeyColumns(database, "entries")).toEqual(["b", "a"]);
  expect(observation.queries).toEqual([]);
  database.exec("ALTER TABLE entries ADD COLUMN title TEXT");
  expect(tableHasColumn(database, "entries", "title")).toBe(true);
  database.exec("BEGIN; ALTER TABLE entries ADD COLUMN pending TEXT");
  expect(tableHasColumn(database, "entries", "pending")).toBe(true);
  database.exec("ROLLBACK");
  expect(tableHasColumn(database, "entries", "pending")).toBe(false);
  expect(tableHasColumn(database, "entries", "title")).toBe(true);
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
  expect(tableHasColumn(database, "generated", "base")).toBe(true);
  expect(tableHasColumn(database, "generated", "derived")).toBe(false);
  expect(tableHasColumn(database, "projected", "base")).toBe(true);
  expect(tableHasColumn(database, "search", "body")).toBe(true);
  expect(tableHasColumn(database, "search", "rank")).toBe(false);
});

it("recovers from out-of-band column additions across retained, transactional, and reopened handles", () => {
  const directFile = path.join(tempDirs.make("ensure-col-direct-"), "state.sqlite");
  const direct = openDatabase("CREATE TABLE entries (id INTEGER);", true, directFile);
  expect(tableHasColumn(direct, "entries", "setup_id")).toBe(false);

  using rawDirect = new DatabaseSync(directFile);
  rawDirect.exec("ALTER TABLE entries ADD COLUMN setup_id TEXT;");
  rawDirect.close();

  expect(ensureColumn(direct, "entries", "setup_id TEXT")).toBe(false);
  const directReads = observeSqliteReadSql(StatementSync.prototype);
  try {
    expect(tableHasColumn(direct, "entries", "setup_id")).toBe(true);
    expect(ensureColumn(direct, "entries", "setup_id TEXT")).toBe(false);
    expect(directReads.queries).toEqual([]);
  } finally {
    directReads.restore();
  }

  // Quoted mixed-case identifiers with whitespace still resolve against live PRAGMA table_info.
  const quotedFile = path.join(tempDirs.make("ensure-col-quoted-"), "state.sqlite");
  const quoted = openDatabase("CREATE TABLE entries (id INTEGER);", true, quotedFile);
  using rawQuoted = new DatabaseSync(quotedFile);
  rawQuoted.exec('ALTER TABLE entries ADD COLUMN "Existing Name" TEXT;');
  rawQuoted.close();
  expect(ensureColumn(quoted, "entries", '"existing name" TEXT')).toBe(false);

  // Reopened handle inherits retained pre-ALTER admission until duplicate recovery refreshes it.
  const reopenFile = path.join(tempDirs.make("ensure-col-reopen-"), "state.sqlite");
  const first = openDatabase("CREATE TABLE entries (id INTEGER);", true, reopenFile);
  expect(tableHasColumn(first, "entries", "setup_id")).toBe(false);
  first.close();

  using rawReopen = new DatabaseSync(reopenFile);
  rawReopen.exec("ALTER TABLE entries ADD COLUMN setup_id TEXT;");
  rawReopen.close();

  const second = openDatabase("", true, reopenFile);
  expect(ensureColumn(second, "entries", "setup_id TEXT")).toBe(false);
  second.close();
  const third = openDatabase("", true, reopenFile);
  const reopenReads = observeSqliteReadSql(StatementSync.prototype);
  try {
    expect(tableHasColumn(third, "entries", "setup_id")).toBe(true);
    expect(reopenReads.queries).toEqual([]);
  } finally {
    reopenReads.restore();
  }

  // Transactional recovery refreshes local facts and keeps post-rollback reads from reverting to stale absence.
  const txnFile = path.join(tempDirs.make("ensure-col-txn-"), "state.sqlite");
  const txnDb = openDatabase("CREATE TABLE entries (id INTEGER);", true, txnFile);
  expect(tableHasColumn(txnDb, "entries", "setup_id")).toBe(false);
  using rawTxn = new DatabaseSync(txnFile);
  rawTxn.exec("ALTER TABLE entries ADD COLUMN setup_id TEXT;");
  rawTxn.close();

  txnDb.exec("BEGIN IMMEDIATE");
  try {
    expect(ensureColumn(txnDb, "entries", "setup_id TEXT")).toBe(false);
    expect(tableHasColumn(txnDb, "entries", "setup_id")).toBe(true);
  } finally {
    txnDb.exec("ROLLBACK");
  }
  expect(tableHasColumn(txnDb, "entries", "setup_id")).toBe(true);
});

it("rethrows non-duplicate ALTER errors, avoids healthy PRAGMA probes, and fails closed when unconfirmed", () => {
  const database = openDatabase(
    "CREATE TABLE entries (id INTEGER); INSERT INTO entries VALUES (1);",
  );
  const reads = observeSqliteReadSql(StatementSync.prototype);
  try {
    expect(ensureColumn(database, "entries", "fresh TEXT")).toBe(true);
    expect(reads.queries.filter((sql) => /PRAGMA\s+table_info/iu.test(sql))).toEqual([]);
  } finally {
    reads.restore();
  }
  expect(() => ensureColumn(database, "entries", "required TEXT NOT NULL")).toThrow(
    /Cannot add a NOT NULL column/iu,
  );
  if (typeof DatabaseSync.prototype.setAuthorizer === "function") {
    database.setAuthorizer((action) =>
      action === constants.SQLITE_PRAGMA ? constants.SQLITE_IGNORE : constants.SQLITE_OK,
    );
    expect(() => ensureColumn(database, "entries", "fresh TEXT")).toThrow(
      /duplicate column name/iu,
    );
    database.setAuthorizer(null);
  }
});
