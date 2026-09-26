import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasSqliteSessionOwnerColumns } from "../config/sessions/session-accessor.sqlite-owner-projection.js";
import { assertSupportedAgentSchemaVersion } from "../state/openclaw-agent-db-schema-read.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  enableNodeSqliteKyselyStatementCache,
  registerNodeSqliteDisposeCallback,
} from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqlitePinnedReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "./sqlite-schema-facts.js";

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

  it.each(["exec", "run", "get", "all", "iterate"] as const)(
    "retains transactional facts across CASE queries executed through %s",
    (method) => {
      const database = openDatabase(undefined, false);
      database.exec("BEGIN");
      admitSqliteSchema(database);
      // The backup schema query orders tables before indexes with CASE ... END.
      const queries = [
        `SELECT type, name, tbl_name AS tableName, sql
        FROM sqlite_master
        WHERE type IN ('table', 'index', 'trigger')
          AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
        "UPDATE original SET id = CASE WHEN id IS NULL THEN 0 ELSE id END",
        "/* BEGIN; END */ SELECT '; ROLLBACK; END' AS [END], 1 AS `COMMIT`, 2 AS \"RELEASE\" -- COMMIT",
      ];
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        for (const query of queries) {
          const statement = database.prepare(query);
          for (let index = 0; index < 10; index += 1) {
            if (method === "exec") {
              database.exec(query);
            } else if (method === "iterate") {
              Array.from(statement.iterate());
            } else {
              statement[method]();
            }
            expect(tableExists(database, "original")).toBe(true);
          }
        }
        expect(
          observation.queries.filter((sql) => /FROM main\.sqlite_schema/iu.test(sql)),
        ).toHaveLength(0);
      } finally {
        observation.restore();
        database.exec("ROLLBACK");
      }
    },
  );

  it("retains table and column facts across 100 foreign data commits", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-data-"), "state.sqlite");
    const reader = openDatabase(
      "CREATE TABLE session_nodes (id INTEGER); PRAGMA user_version = 1;",
      true,
      filename,
    );
    reader.exec("PRAGMA journal_mode=WAL");
    const writer = new DatabaseSync(filename);
    databases.push(writer);
    const read = () =>
      runSqliteReadOperationSync(reader, () => {
        expect(tableExists(reader, "session_nodes")).toBe(true);
        expect(hasSqliteSessionOwnerColumns(reader)).toBe(false);
        expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(1);
      });
    read();
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      const insert = writer.prepare("INSERT INTO session_nodes VALUES (?)");
      for (let index = 0; index < 100; index += 1) {
        insert.run(index);
        read();
      }
      expect(
        observation.queries.filter((sql) => /sqlite_schema|pragma_table_info/iu.test(sql)),
      ).toHaveLength(0);
      expect(
        observation.queries.filter((sql) => /PRAGMA schema_version/iu.test(sql)).length,
      ).toBeLessThanOrEqual(100);
    } finally {
      observation.restore();
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
      const hasTable = (name: string) =>
        runSqliteReadOperationSync(reader, () => tableExists(reader, name));
      expect(hasTable("committed")).toBe(false);
      writer.exec("BEGIN; CREATE TABLE committed (id); PRAGMA user_version = 2; COMMIT;");
      expect(hasTable("committed")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(2);

      const readSnapshot = () => {
        expect(hasTable("later")).toBe(false);
        writer.exec("BEGIN; CREATE TABLE later (id); PRAGMA user_version = 3; COMMIT;");
        expect(hasTable("later")).toBe(false);
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
      expect(hasTable("later")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(3);
      writer.exec("PRAGMA user_version = 2147483647");
      expect(() => assertSupportedAgentSchemaVersion(reader, filename)).toThrow(
        /newer schema version/iu,
      );
    },
  );

  it("ends nested read scopes on exceptions and before async continuations", async () => {
    const filename = path.join(tempDirs.make("openclaw-schema-read-scope-"), "state.sqlite");
    const reader = openDatabase(undefined, true, filename);
    const writer = new DatabaseSync(filename);
    databases.push(writer);
    const hasTable = (name: string) =>
      runSqliteReadOperationSync(reader, () => tableExists(reader, name));
    expect(() =>
      runSqliteReadOperationSync(reader, () => {
        expect(hasTable("committed")).toBe(false);
        throw new Error("read failed");
      }),
    ).toThrow("read failed");
    writer.exec("CREATE TABLE committed (id)");
    expect(hasTable("committed")).toBe(true);

    await runSqliteReadOperationSync(reader, async () => {
      expect(hasTable("later")).toBe(false);
      await Promise.resolve();
      writer.exec("CREATE TABLE later (id)");
      expect(hasTable("later")).toBe(true);
    });
  });

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

  it.each(["exec", "prepare"] as const)(
    "tracks commented transaction controls through %s",
    (method) => {
      const database = openDatabase();
      const execute = (sql: string) =>
        method === "exec" ? database.exec(sql) : database.prepare(sql).run();
      execute(" ; -- start\n /* transaction */ bEgIn IMMEDIATE TRANSACTION");
      execute("/* nested */ SaVePoInT schema_change");
      database.exec("CREATE TABLE first (id); PRAGMA user_version = 2;");
      const firstCookie = database.prepare("PRAGMA schema_version").get()?.schema_version;
      expect(tableExists(database, "first")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(2);

      execute("-- undo\n /* nested */ RoLlBaCk TRANSACTION TO SAVEPOINT schema_change");
      database.exec("CREATE TABLE second (id); PRAGMA user_version = 3;");
      execute("/* done */ ReLeAsE SAVEPOINT schema_change");
      expect(database.prepare("PRAGMA schema_version").get()?.schema_version).toBe(firstCookie);
      expect(tableExists(database, "first")).toBe(false);
      expect(tableExists(database, "second")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(3);

      execute("/* undo */ RoLlBaCk TRANSACTION;");
      expect(tableExists(database, "second")).toBe(false);
      expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(1);

      execute("-- next\n BEGIN EXCLUSIVE TRANSACTION");
      database.exec("CREATE TABLE committed (id); PRAGMA user_version = 4;");
      expect(tableExists(database, "committed")).toBe(true);
      execute("/* publish */ CoMmIt TRANSACTION;");
      expect(tableExists(database, "committed")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(4);
      execute("BEGIN DEFERRED");
      database.exec("CREATE TABLE ended (id)");
      expect(tableExists(database, "ended")).toBe(true);
      execute("-- publish\n EnD TRANSACTION");
      expect(tableExists(database, "ended")).toBe(true);
    },
  );

  it("observes controls after ordinary statements in exec batches", () => {
    const database = openDatabase();
    database.exec("BEGIN; SAVEPOINT nested; CREATE TABLE undone (id)");
    expect(tableExists(database, "undone")).toBe(true);
    database.exec("SELECT '; END'; -- undo\n /* change */ ROLLBACK TO nested");
    expect(database.isTransaction).toBe(true);
    expect(tableExists(database, "undone")).toBe(false);
    database.exec("CREATE TABLE committed (id)");
    expect(tableExists(database, "committed")).toBe(true);
    database.exec("SELECT CASE WHEN 1 THEN 'END' END; /* publish */ END; BEGIN");
    expect(database.isTransaction).toBe(true);
    expect(tableExists(database, "committed")).toBe(true);
    database.exec("ROLLBACK");
    expect(tableExists(database, "committed")).toBe(true);
  });

  it.each(["exec", "prepare"] as const)(
    "discards implicitly rolled-back DDL before %s begins again",
    (method) => {
      const database = openDatabase(
        "CREATE TABLE original (id INTEGER UNIQUE ON CONFLICT ROLLBACK); INSERT INTO original VALUES (1);",
      );
      database.exec("BEGIN; CREATE TABLE rolled_back (id);");
      expect(tableExists(database, "rolled_back")).toBe(true);
      expect(() => database.prepare("INSERT INTO original VALUES (1)").run()).toThrow();
      expect(database.isTransaction).toBe(false);
      const begin = "; /* next */ -- transaction\n BEGIN DEFERRED TRANSACTION;";
      if (method === "exec") {
        database.exec(begin);
      } else {
        database.prepare(begin).run();
      }
      expect(tableExists(database, "rolled_back")).toBe(false);
      database.exec("ROLLBACK;");
    },
  );

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
