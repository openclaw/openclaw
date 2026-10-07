import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasSqliteSessionOwnerColumns } from "../config/sessions/session-accessor.sqlite-owner-projection.js";
import { assertCanonicalSessionValidationSchema } from "../state/openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { assertSupportedAgentSchemaVersion } from "../state/openclaw-agent-db-schema-read.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  enableNodeSqliteKyselyStatementCache,
  registerNodeSqliteDisposeCallback,
} from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqlitePinnedReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  adoptSqliteSchemaFacts,
  getAdmittedSqliteSchemaFacts,
  readSqliteCacheDataVersion,
  readSqliteDataVersion,
  registerSqliteSchemaMutationListener,
  runSqliteReadOperationSync,
} from "./sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

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

  it("serves admitted runtime schema checks without executing SQL", () => {
    const database = openDatabase(
      `${OPENCLAW_AGENT_SCHEMA_SQL}\nPRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`,
      false,
    );
    assertCanonicalSessionValidationSchema(database);
    admitSqliteSchema(database);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      for (let index = 0; index < 10; index += 1) {
        expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(tableExists(database, "session_nodes")).toBe(true);
        assertCanonicalSessionValidationSchema(database);
      }
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
  });

  it("refreshes writer admission after BEGIN despite an enclosing read operation", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-writer-"), "agent.sqlite");
    const database = openDatabase(
      `${OPENCLAW_AGENT_SCHEMA_SQL}\nPRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`,
      true,
      filename,
    );
    database.exec("PRAGMA journal_mode=WAL");
    assertCanonicalSessionValidationSchema(database);
    const peer = new DatabaseSync(filename);
    databases.push(peer);
    runSqliteReadOperationSync(database, () => {
      peer.exec("DROP TRIGGER session_nodes_canonical_pending_after_update");
      expect(() =>
        runSqliteImmediateTransactionSync(database, () =>
          assertCanonicalSessionValidationSchema(database),
        ),
      ).toThrow(/canonical validation schema is missing or drifted/u);
      expect(database.isTransaction).toBe(false);
    });
  });

  it.each(["exec", "all"] as const)(
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
        `${"/* ** END; /* nested opener */ ".repeat(100)} SELECT 1`,
      ];
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        for (const query of queries) {
          const statement = database.prepare(query);
          for (let index = 0; index < 10; index += 1) {
            if (method === "exec") {
              database.exec(query);
            } else {
              statement.all();
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
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(reader, schemaMutation);
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
      expect(schemaMutation).not.toHaveBeenCalled();
    } finally {
      observation.restore();
    }
  });

  it("does not retain an expired snapshot's identity when adopting matching facts", () => {
    const database = openDatabase(undefined, false);
    const facts = runSqlitePinnedReadSnapshotSync(database, () => {
      admitSqliteSchema(database);
      return getAdmittedSqliteSchemaFacts(database)!;
    });
    expect(adoptSqliteSchemaFacts(database, structuredClone(facts))).toBe(true);
    expect(getAdmittedSqliteSchemaFacts(database)).not.toBe(facts);
    expect(tableExists(database, "original")).toBe(true);
  });

  it("invalidates derived column facts when adopting a foreign schema publication", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-adoption-"), "state.sqlite");
    const reader = openDatabase("CREATE TABLE session_nodes (id INTEGER)", true, filename);
    expect(hasSqliteSessionOwnerColumns(reader)).toBe(false);
    const writer = new DatabaseSync(filename);
    databases.push(writer);
    writer.exec(`
      ALTER TABLE session_nodes ADD COLUMN owner_actor_type TEXT;
      ALTER TABLE session_nodes ADD COLUMN owner_actor_id TEXT;
      ALTER TABLE session_nodes ADD COLUMN owner_assigned_by_type TEXT;
      ALTER TABLE session_nodes ADD COLUMN owner_assigned_by_id TEXT;
      ALTER TABLE session_nodes ADD COLUMN owner_assigned_at INTEGER;
    `);
    const publisher = openDatabase("", true, filename);
    const facts = getAdmittedSqliteSchemaFacts(publisher);
    expect(facts).toBeDefined();
    expect(adoptSqliteSchemaFacts(reader, facts!)).toBe(true);
    expect(hasSqliteSessionOwnerColumns(reader)).toBe(true);
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
      const schemaMutation = vi.fn();
      registerSqliteSchemaMutationListener(reader, schemaMutation);
      const hasTable = (name: string) =>
        runSqliteReadOperationSync(reader, () => tableExists(reader, name));
      expect(hasTable("committed")).toBe(false);
      writer.exec(
        "BEGIN; CREATE TABLE committed (id); CREATE INDEX committed_index ON committed(id); PRAGMA user_version = 2; COMMIT;",
      );
      expect(hasTable("committed")).toBe(true);
      expect(getAdmittedSqliteSchemaFacts(reader)?.indexes.has("committed_index")).toBe(true);
      expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(2);
      expect(schemaMutation).toHaveBeenCalledTimes(1);

      const readSnapshot = () => {
        expect(hasTable("later")).toBe(false);
        writer.exec(
          "BEGIN; CREATE TABLE later (id); DROP INDEX committed_index; PRAGMA user_version = 3; COMMIT;",
        );
        expect(hasTable("later")).toBe(false);
        expect(getAdmittedSqliteSchemaFacts(reader)?.indexes.has("committed_index")).toBe(true);
        expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(2);
        expect(schemaMutation).toHaveBeenCalledTimes(1);
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
      expect(getAdmittedSqliteSchemaFacts(reader)?.indexes.has("committed_index")).toBe(false);
      expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(3);
      expect(schemaMutation).toHaveBeenCalledTimes(2);
      writer.exec("PRAGMA user_version = 2147483647");
      expect(() =>
        runSqliteReadOperationSync(reader, () =>
          assertSupportedAgentSchemaVersion(reader, filename),
        ),
      ).toThrow(/newer schema version/iu);
    },
  );

  it("ends nested read scopes on exceptions and before async continuations", async () => {
    const filename = path.join(tempDirs.make("openclaw-schema-read-scope-"), "state.sqlite");
    const reader = openDatabase(undefined, false, filename);
    const writer = new DatabaseSync(filename);
    databases.push(writer);
    const hasTable = (name: string) =>
      runSqliteReadOperationSync(reader, () => tableExists(reader, name));
    const admission = observeSqliteReadSql(StatementSync.prototype);
    expect(() =>
      runSqliteReadOperationSync(reader, () => {
        admitSqliteSchema(reader);
        expect(hasTable("committed")).toBe(false);
        throw new Error("read failed");
      }),
    ).toThrow("read failed");
    admission.restore();
    expect(admission.queries.filter((sql) => /^PRAGMA data_version$/iu.test(sql))).toHaveLength(1);
    writer.exec("CREATE TABLE committed (id)");
    expect(hasTable("committed")).toBe(true);

    await runSqliteReadOperationSync(reader, async () => {
      expect(hasTable("later")).toBe(false);
      await Promise.resolve();
      writer.exec("CREATE TABLE later (id)");
      expect(hasTable("later")).toBe(true);
    });
  });

  it("executes fresh version probes inside a read scope without preparing warm statements", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-fresh-"), "state.sqlite");
    const reader = openDatabase(undefined, true, filename);
    const writer = new DatabaseSync(filename);
    databases.push(writer);
    readSqliteDataVersion(reader);
    readSqliteDataVersion(reader);
    const prepare = vi.spyOn(reader, "prepare");
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      let committedVersion = 0;
      runSqliteReadOperationSync(reader, () => {
        const before = readSqliteCacheDataVersion(reader);
        writer.exec("INSERT INTO original VALUES (1)");
        expect(readSqliteCacheDataVersion(reader)).toBe(before);
        committedVersion = readSqliteDataVersion(reader);
        expect(committedVersion).not.toBe(before);
        expect(readSqliteCacheDataVersion(reader)).toBe(before);
        expect(readSqliteDataVersion(reader)).toBe(committedVersion);
      });
      expect(readSqliteCacheDataVersion(reader)).toBe(committedVersion);
      expect(observation.queries.filter((sql) => /^PRAGMA data_version$/iu.test(sql))).toHaveLength(
        4,
      );
      expect(
        prepare.mock.calls.filter(([sql]) => /^PRAGMA data_version$/iu.test(sql)),
      ).toHaveLength(0);
    } finally {
      observation.restore();
      prepare.mockRestore();
    }
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
    runSqliteReadOperationSync(reader, () => {
      expect(tableExists(reader, "later")).toBe(false);
    });
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

  it.each([
    { method: "run", admitted: true, binding: undefined },
    { method: "get", admitted: true, binding: undefined },
    { method: "all", admitted: true, binding: undefined },
    { method: "iterate", admitted: true, binding: undefined },
    { method: "run", admitted: false, binding: undefined },
    { method: "run", admitted: true, binding: "positional" },
    { method: "run", admitted: true, binding: "named" },
  ] as const)(
    "tracks prepared DDL: $method, admitted=$admitted, binding=$binding",
    ({ method, admitted, binding }) => {
      const database = openDatabase(undefined, admitted);
      const table = admitted ? "prepared_table" : "original";
      const sql = !admitted
        ? "DROP TABLE original"
        : binding
          ? `CREATE TABLE prepared_table AS SELECT ${binding === "named" ? "$id" : "?"} AS id`
          : "CREATE TABLE prepared_table (id)";
      const statement = database.prepare(sql);
      if (!admitted) {
        admitSqliteSchema(database);
      }
      expect(tableExists(database, table)).toBe(!admitted);
      if (method === "iterate") {
        expect([...statement.iterate()]).toEqual([]);
      } else if (binding === "named") {
        statement.run({ $id: 11 });
      } else if (binding === "positional") {
        statement.run(7);
      } else {
        statement[method]();
      }
      expect(tableExists(database, table)).toBe(admitted);
      if (binding) {
        expect(database.prepare("SELECT id FROM prepared_table").get()).toEqual({
          id: binding === "named" ? 11 : 7,
        });
      }
      database.prepare("PRAGMA user_version = 5").run();
      expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(5);
    },
  );

  it("closes failed native write iterators before their statement is reused", () => {
    const database = openDatabase("CREATE TABLE original (id INTEGER PRIMARY KEY)");
    const insert = database.prepare("INSERT INTO original VALUES (?) RETURNING id");
    expect([...insert.iterate(1)]).toEqual([{ id: 1 }]);

    const rejected = insert.iterate(1);
    expect(() => rejected.next()).toThrow("UNIQUE constraint failed");
    rejected.return?.();

    database.prepare("DELETE FROM original WHERE id = ?").run(1);
    expect([...insert.iterate(2)]).toEqual([{ id: 2 }]);
    expect(database.prepare("SELECT id FROM original").all()).toEqual([{ id: 2 }]);
  });

  it("retains successful DDL preceding a failed multi-statement batch", () => {
    const database = openDatabase();
    expect(() =>
      database.exec("CREATE TABLE completed (id); PRAGMA user_version = 6; SELECT * FROM missing;"),
    ).toThrow(/no such table/iu);
    expect(tableExists(database, "completed")).toBe(true);
    expect(assertSupportedAgentSchemaVersion(database, ":memory:")).toBe(6);
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function").each([false, true])(
    "honors dynamic authorizer policy installed with admitted=%s",
    (admitted) => {
      const database = openDatabase(undefined, admitted);
      let allowed = true;
      database.setAuthorizer(() => (allowed ? constants.SQLITE_OK : constants.SQLITE_DENY));
      if (!admitted) {
        admitSqliteSchema(database);
      }
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
    const database = openDatabase(
      "CREATE TABLE original (id); CREATE INDEX original_index ON original(id)",
    );
    expect(tableExists(database, "original")).toBe(true);
    expect(getAdmittedSqliteSchemaFacts(database)?.indexes.has("original_index")).toBe(true);
    database.close();
    expect(() => tableExists(database, "original")).toThrow();
    database.open();
    expect(tableExists(database, "original")).toBe(false);
    expect(getAdmittedSqliteSchemaFacts(database)?.indexes.has("original_index")).toBe(false);
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
