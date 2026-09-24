import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSupportedAgentSchemaVersion } from "../state/openclaw-agent-db-schema-read.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  enableNodeSqliteKyselyStatementCache,
  registerNodeSqliteDisposeCallback,
} from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqlitePinnedReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";

describe("admitted SQLite schema facts", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const databases: DatabaseSync[] = [];

  function openDatabase(
    schema = "CREATE TABLE original (id INTEGER); PRAGMA user_version = 1;",
    admitted = true,
    location = ":memory:",
  ) {
    const database = openNodeSqliteDatabase(location);
    databases.push(database);
    database.exec(schema);
    enableNodeSqliteKyselyStatementCache(database);
    if (admitted) {
      admitSqliteSchema(database);
    }
    return database;
  }

  afterEach(() => {
    for (const database of databases.splice(0)) {
      if (database.isOpen) {
        database.close();
      }
    }
  });

  it.each(["transaction", "implicit snapshot"])(
    "observes foreign commits on the next read while preserving an active %s",
    (pin) => {
      const filename = path.join(tempDirs.make("openclaw-schema-foreign-"), "state.sqlite");
      const reader = openDatabase(undefined, true, filename);
      reader.exec("PRAGMA journal_mode=WAL");
      // Bypass local schema publications, as a worker or another process does.
      const writer = new DatabaseSync(filename);
      databases.push(writer);
      expect(tableExists(reader, "committed")).toBe(false);
      writer.exec("BEGIN; CREATE TABLE committed (id); PRAGMA user_version = 2; COMMIT;");
      expect(tableExists(reader, "committed")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(2);

      const readSnapshot = () => {
        expect(tableExists(reader, "later")).toBe(false);
        writer.exec("BEGIN; CREATE TABLE later (id); PRAGMA user_version = 3; COMMIT;");
        expect(tableExists(reader, "later")).toBe(false);
        expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(2);
      };
      if (pin === "transaction") {
        reader.exec("BEGIN");
        try {
          reader.prepare("SELECT id FROM original").all();
          readSnapshot();
        } finally {
          reader.exec("COMMIT");
        }
      } else {
        runSqlitePinnedReadSnapshotSync(reader, readSnapshot);
      }
      expect(tableExists(reader, "later")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(3);
    },
  );

  it("publishes local DDL to sibling handles while preserving their active snapshots", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-siblings-"), "state.sqlite");
    const writer = openDatabase(undefined, true, filename);
    writer.exec("PRAGMA journal_mode=WAL");
    const reader = openDatabase("", true, filename);
    expect(tableExists(reader, "committed")).toBe(false);
    writer.exec("BEGIN; CREATE TABLE committed (id)");
    expect(tableExists(reader, "committed")).toBe(false);
    writer.exec("COMMIT");
    expect(tableExists(reader, "committed")).toBe(true);

    reader.exec("BEGIN");
    reader.prepare("SELECT id FROM original").all();
    writer.exec("CREATE TABLE later (id)");
    expect(tableExists(reader, "later")).toBe(false);
    reader.exec("COMMIT");
    expect(tableExists(reader, "later")).toBe(true);

    writer.exec("BEGIN; CREATE TABLE retained_after_close_failure (id)");
    const unregister = registerNodeSqliteDisposeCallback(writer, () => {
      throw new Error("synthetic close refusal");
    });
    try {
      expect(() => writer.close()).toThrow("synthetic close refusal");
    } finally {
      unregister();
    }
    writer.exec("COMMIT");
    expect(tableExists(reader, "retained_after_close_failure")).toBe(true);

    expect(tableExists(reader, "batched")).toBe(false);
    writer.exec("BEGIN; CREATE TABLE batched (id)");
    writer.exec("COMMIT; BEGIN");
    expect(tableExists(reader, "batched")).toBe(true);
    writer.exec("ROLLBACK");

    runSqlitePinnedReadSnapshotSync(reader, () => {
      writer.exec("CREATE TABLE implicit_snapshot (id)");
      expect(tableExists(reader, "implicit_snapshot")).toBe(false);
    });
    expect(tableExists(reader, "implicit_snapshot")).toBe(true);
  });

  it("tracks transactional DDL through savepoint cookie reuse, rollback, and commit", () => {
    const database = openDatabase();
    database.exec(
      "BEGIN; SAVEPOINT schema_change; CREATE TABLE first (id); PRAGMA user_version = 2;",
    );
    const firstCookie = database.prepare("PRAGMA schema_version").get()?.schema_version;
    expect(tableExists(database, "first")).toBe(true);
    expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(2);

    database.exec(
      "ROLLBACK TO schema_change; CREATE TABLE second (id); PRAGMA user_version = 3; RELEASE schema_change;",
    );
    expect(database.prepare("PRAGMA schema_version").get()?.schema_version).toBe(firstCookie);
    expect(tableExists(database, "first")).toBe(false);
    expect(tableExists(database, "second")).toBe(true);
    expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(3);

    database.exec("ROLLBACK;");
    expect(tableExists(database, "second")).toBe(false);
    expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(1);

    database.exec("BEGIN; CREATE TABLE committed (id); PRAGMA user_version = 4;");
    expect(tableExists(database, "committed")).toBe(true);
    database.exec("COMMIT;");
    expect(tableExists(database, "committed")).toBe(true);
    expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(4);
  });

  it("discards DDL from an implicit rollback before a new transaction starts", () => {
    const database = openDatabase(
      "CREATE TABLE original (id INTEGER UNIQUE ON CONFLICT ROLLBACK); INSERT INTO original VALUES (1);",
    );
    database.exec("BEGIN; CREATE TABLE rolled_back (id);");
    expect(tableExists(database, "rolled_back")).toBe(true);
    expect(() => database.prepare("INSERT INTO original VALUES (1)").run()).toThrow();
    expect(database.isTransaction).toBe(false);
    database.exec("BEGIN;");
    expect(tableExists(database, "rolled_back")).toBe(false);
    database.exec("ROLLBACK;");
  });

  it.each(["run", "get", "all", "iterate"] as const)(
    "observes prepared DDL when executed through %s",
    (method) => {
      const database = openDatabase();
      const create = database.prepare("CREATE TABLE prepared_table (id)");
      expect(tableExists(database, "prepared_table")).toBe(false);
      if (method === "iterate") {
        expect([...create.iterate()]).toEqual([]);
      } else {
        create[method]();
      }
      expect(tableExists(database, "prepared_table")).toBe(true);
      database.prepare("PRAGMA user_version = 5").run();
      expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(5);
    },
  );

  it("retains successful DDL preceding a failed multi-statement batch", () => {
    const database = openDatabase();
    expect(() =>
      database.exec("CREATE TABLE completed (id); PRAGMA user_version = 6; SELECT * FROM missing;"),
    ).toThrow(/no such table/iu);
    expect(tableExists(database, "completed")).toBe(true);
    expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(6);
  });

  it("tracks schema statements retained before admission", () => {
    const database = openDatabase(undefined, false);
    const drop = database.prepare("DROP TABLE original");
    admitSqliteSchema(database);
    expect(tableExists(database, "original")).toBe(true);
    drop.run();
    expect(tableExists(database, "original")).toBe(false);
  });

  it("preserves positional and named parameters for prepared DDL", () => {
    const database = openDatabase();
    database.prepare("CREATE TABLE positional AS SELECT ? AS id").run(7);
    database.prepare("CREATE TABLE named AS SELECT $id AS id").run({ $id: 11 });
    expect(tableExists(database, "positional")).toBe(true);
    expect(tableExists(database, "named")).toBe(true);
    expect(database.prepare("SELECT id FROM positional").get()).toEqual({ id: 7 });
    expect(database.prepare("SELECT id FROM named").get()).toEqual({ id: 11 });
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "retains authorizer policy installed before admission",
    () => {
      const database = openDatabase(undefined, false);
      let allowed = true;
      database.setAuthorizer(() => (allowed ? constants.SQLITE_OK : constants.SQLITE_DENY));
      admitSqliteSchema(database);
      expect(tableExists(database, "original")).toBe(true);
      allowed = false;
      expect(() => tableExists(database, "original")).toThrow(/not authorized/iu);
      database.setAuthorizer(null);
    },
  );

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "honors dynamic authorizer denials after admission and removal",
    () => {
      const database = openDatabase();
      let allowed = true;
      database.setAuthorizer(() => (allowed ? constants.SQLITE_OK : constants.SQLITE_DENY));
      expect(tableExists(database, "original")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(1);
      allowed = false;
      expect(() => tableExists(database, "original")).toThrow(/not authorized/iu);
      expect(() => assertSupportedAgentSchemaVersion(database, ":memory:")).toThrow(
        /not authorized/iu,
      );
      database.setAuthorizer(null);
      expect(tableExists(database, "original")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(1);
    },
  );

  it("does not serve retained facts after close or reopening the handle", () => {
    const database = openDatabase();
    expect(tableExists(database, "original")).toBe(true);
    database.close();
    expect(() => tableExists(database, "original")).toThrow();
    database.open();
    expect(tableExists(database, "original")).toBe(false);
    expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(0);
  });

  it.skipIf(typeof DatabaseSync.prototype.deserialize !== "function")(
    "re-admits replacement content after deserialize",
    () => {
      const database = openDatabase();
      const replacement = openDatabase("CREATE TABLE replacement (id); PRAGMA user_version = 7;");
      database.deserialize(replacement.serialize());
      expect(tableExists(database, "original")).toBe(false);
      expect(tableExists(database, "replacement")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(7);
    },
  );
});
