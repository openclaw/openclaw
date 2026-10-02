import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "./kysely-sync-cache-state.js";
import {
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
} from "./sqlite-schema-contract.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("compares one committed schema and observes later changes on the next inspection", () => {
  const directory = tempDirs.make("openclaw-schema-snapshot-");
  const filename = path.join(directory, "state.sqlite");
  const writer = new DatabaseSync(filename);
  const schema = "CREATE TABLE a (id INTEGER); CREATE TABLE z (id INTEGER);";
  writer.exec(`PRAGMA journal_mode=WAL; ${schema}`);
  const reader = new DatabaseSync(filename, { readOnly: true });
  try {
    const readTable = createSqliteTableContractReader(reader);
    let changed = false;
    const issues = collectSqliteSchemaIssues(reader, schema, {}, (name) => {
      const contract = readTable(name);
      if (!changed) {
        changed = true;
        const remainingTable = name === "a" ? "z" : "a";
        writer.exec(`ALTER TABLE ${remainingTable} ADD COLUMN later TEXT`);
      }
      return contract;
    });
    expect(changed).toBe(true);
    expect(issues).toEqual([]);
    expect(reader.isTransaction).toBe(false);
    expect(collectSqliteSchemaIssues(reader, schema)).not.toEqual([]);
    expect(reader.isTransaction).toBe(false);
  } finally {
    reader.close();
    writer.close();
  }
});

it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
  "does not require transaction-control authorization for top-level or nested inspections",
  () => {
    const database = new DatabaseSync(":memory:");
    const schema = "CREATE TABLE records (id INTEGER);";
    database.exec(schema);
    const denyTransactionControl = (action: number) =>
      action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK;
    try {
      database.setAuthorizer(denyTransactionControl);
      expect(collectSqliteSchemaIssues(database, schema)).toEqual([]);
      expect(database.isTransaction).toBe(false);
      database.setAuthorizer(null);

      database.exec("BEGIN");
      database.exec("INSERT INTO records VALUES (1)");
      database.setAuthorizer(denyTransactionControl);
      expect(collectSqliteSchemaIssues(database, schema)).toEqual([]);
      expect(database.isTransaction).toBe(true);
      database.setAuthorizer(null);
      database.exec("ROLLBACK");
      expect(database.prepare("SELECT * FROM records").all()).toEqual([]);
    } finally {
      database.setAuthorizer(null);
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }
      database.close();
    }
  },
);

it("releases a failed inspection so another connection can write and a cached retry reads fresh facts", () => {
  const directory = tempDirs.make("openclaw-schema-snapshot-failure-");
  const filename = path.join(directory, "state.sqlite");
  const writer = new DatabaseSync(filename);
  const schema = "CREATE TABLE records (id INTEGER);";
  writer.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; ${schema}`);
  const reader = new DatabaseSync(filename, { readOnly: true });
  enableNodeSqliteKyselyStatementCache(reader);
  const failure = new Error("inspection failed");
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(collectSqliteSchemaIssues(reader, schema)).toEqual([]);
    }
    expect(() =>
      collectSqliteSchemaIssues(reader, schema, {}, () => {
        // DELETE mode proves a real read lock exists, not just an autocommit flag.
        expect(() => writer.exec("INSERT INTO records VALUES (1)")).toThrow(/locked/iu);
        throw failure;
      }),
    ).toThrow(failure);
    writer.exec("ALTER TABLE records ADD COLUMN later TEXT");
    expect(collectSqliteSchemaIssues(reader, schema)).toEqual([
      {
        code: "unexpected-column",
        objectName: "records.later",
        message: "column definitions differ for records",
      },
    ]);
    expect(reader.isTransaction).toBe(false);
  } finally {
    reader.close();
    writer.close();
  }
});

it("retries a cached snapshot immediately after an exclusive writer releases its lock", () => {
  const filename = path.join(tempDirs.make("openclaw-schema-snapshot-busy-"), "state.sqlite");
  const writer = new DatabaseSync(filename);
  const schema = "CREATE TABLE records (id INTEGER);";
  writer.exec(`PRAGMA journal_mode=DELETE; ${schema}`);
  const reader = new DatabaseSync(filename, { readOnly: true });
  reader.exec("PRAGMA busy_timeout=0");
  enableNodeSqliteKyselyStatementCache(reader);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(collectSqliteSchemaIssues(reader, schema)).toEqual([]);
    }
    writer.exec("BEGIN EXCLUSIVE");
    expect(() => collectSqliteSchemaIssues(reader, schema)).toThrow(/locked/iu);
    writer.exec("ROLLBACK");
    expect(collectSqliteSchemaIssues(reader, schema)).toEqual([]);
  } finally {
    reader.close();
    writer.close();
  }
});
