import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "./kysely-sync-cache-state.js";
import { runSqliteSchemaReadSnapshotSync as withSchemaSnapshot } from "./sqlite-pinned-read-snapshot.js";
import { createSqliteTableContractReader } from "./sqlite-schema-contract.js";
import {
  collectSqliteSchemaIssues as schemaIssues,
  sqliteSchemaFixture,
} from "./sqlite-schema-contract.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["top-level", "nested"] as const)(
  "compares one committed schema during %s inspection and observes the next commit",
  (scope) => {
    const filename = path.join(tempDirs.make("openclaw-schema-snapshot-"), "state.sqlite");
    using writer = new DatabaseSync(filename);
    const schemaSql = "CREATE TABLE a (id INTEGER); CREATE TABLE z (id INTEGER);";
    const schema = sqliteSchemaFixture(schemaSql);
    writer.exec(`PRAGMA journal_mode=WAL; ${schemaSql}`);
    using reader = new DatabaseSync(filename, { readOnly: true });
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      const readTable = createSqliteTableContractReader(reader);
      let changed = false;
      const inspect = () =>
        schemaIssues(reader, schema, {}, (name) => {
          if (!changed) {
            changed = true;
            writer.exec(`ALTER TABLE ${name === "a" ? "z" : "a"} ADD COLUMN later TEXT`);
          }
          return readTable(name);
        });
      const issues = scope === "nested" ? withSchemaSnapshot(reader, inspect) : inspect();
      const schemaReads = () =>
        observation.queries.filter((sql) => /^PRAGMA schema_version\b/iu.test(sql));
      expect(changed).toBe(true);
      expect(issues).toEqual([]);
      expect(schemaReads()).toHaveLength(1);
      expect(reader.isTransaction).toBe(false);
      expect(schemaIssues(reader, schema)).not.toEqual([]);
      expect(schemaReads()).toHaveLength(2);
      expect(reader.isTransaction).toBe(false);
    } finally {
      observation.restore();
    }
  },
);

it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
  "does not require transaction-control authorization for top-level or nested inspections",
  () => {
    using database = new DatabaseSync(":memory:");
    const schema = "CREATE TABLE records (id INTEGER);";
    database.exec(schema);
    const denyTransactionControl = (action: number) =>
      action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK;
    for (const nested of [false, true]) {
      if (nested) {
        database.exec("BEGIN; INSERT INTO records VALUES (1)");
      }
      database.setAuthorizer(denyTransactionControl);
      expect(schemaIssues(database, schema)).toEqual([]);
      expect(database.isTransaction).toBe(nested);
      database.setAuthorizer(null);
    }
    database.exec("ROLLBACK");
    expect(database.prepare("SELECT * FROM records").all()).toEqual([]);
  },
);

it.each(["inspection callback", "exclusive writer"] as const)(
  "releases a failed %s snapshot so a cached retry reads fresh facts",
  (failureAt) => {
    const filename = path.join(tempDirs.make("openclaw-schema-snapshot-failure-"), "state.sqlite");
    using writer = new DatabaseSync(filename);
    const schema = "CREATE TABLE records (id INTEGER);";
    writer.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; ${schema}`);
    using reader = new DatabaseSync(filename, { readOnly: true });
    reader.exec("PRAGMA busy_timeout=0");
    enableNodeSqliteKyselyStatementCache(reader);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(schemaIssues(reader, schema)).toEqual([]);
    }
    if (failureAt === "inspection callback") {
      const failure = new Error("inspection failed");
      expect(() =>
        schemaIssues(reader, schema, {}, () => {
          // DELETE mode proves a real read lock exists, not just an autocommit flag.
          expect(() => writer.exec("INSERT INTO records VALUES (1)")).toThrow(/locked/iu);
          throw failure;
        }),
      ).toThrow(failure);
      writer.exec("ALTER TABLE records ADD COLUMN later TEXT");
      expect(schemaIssues(reader, schema)).toEqual([
        {
          code: "unexpected-column",
          objectName: "records.later",
          message: "column definitions differ for records",
        },
      ]);
      expect(reader.isTransaction).toBe(false);
    } else {
      writer.exec("BEGIN EXCLUSIVE");
      expect(() => schemaIssues(reader, schema)).toThrow(/locked/iu);
      writer.exec("ROLLBACK");
      expect(schemaIssues(reader, schema)).toEqual([]);
    }
  },
);
