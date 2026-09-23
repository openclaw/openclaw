import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
      database.setAuthorizer(null);

      database.exec("BEGIN");
      database.setAuthorizer(denyTransactionControl);
      expect(collectSqliteSchemaIssues(database, schema)).toEqual([]);
    } finally {
      database.setAuthorizer(null);
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }
      database.close();
    }
  },
);
