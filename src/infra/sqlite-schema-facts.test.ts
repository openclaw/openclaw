import { existsSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { hasSqliteSessionOwnerColumns } from "../config/sessions/session-accessor.sqlite-owner-projection.js";
import { participantRecordsBySessionKey } from "../config/sessions/session-accessor.sqlite-participant-projection.js";
import { assertCanonicalSessionValidationSchema } from "../state/openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { assertSupportedAgentSchemaVersion } from "../state/openclaw-agent-db-schema-read.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { registerNodeSqliteDisposeCallback } from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  getSqliteDatabaseSchemaRevision,
  hasPendingSqliteDatabaseSchemaMutation,
  readSqliteDatabaseWriteRevision,
  readSqliteDatabaseSiblingWriteRevision,
} from "./sqlite-database-admission.js";
import { runSqliteSchemaReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import { withSqlitePostCommitPublications } from "./sqlite-post-commit.js";
import {
  admitSqliteSchema,
  adoptSqliteSchemaFacts,
  getAdmittedSqliteSchemaFacts,
  getSqliteReadOperationRevision,
  installSqliteTempTrackingSchema,
  readSqliteDataVersion,
  registerSqliteSchemaMutationListener,
  runSqliteReadOperationSync,
} from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

describe("admitted SQLite schema facts", () => {
  const { tempDirs, openDatabase, databases } = useSqliteSchemaTestFixture();

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

  it("validates a physical file once across handles and close, and validates its replacement", () => {
    const root = tempDirs.make("openclaw-schema-process-");
    const filename = path.join(root, "state.sqlite");
    const first = openDatabase(undefined, true, filename);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    const schemaReads = () =>
      observation.queries.filter((sql) =>
        /sqlite_schema|PRAGMA (?:user_version|schema_version)/iu.test(sql),
      );
    try {
      const second = openDatabase("", true, filename);
      expect(tableExists(second, "original")).toBe(true);
      second.close();
      first.close();
      const reopened = openDatabase("", true, filename);
      expect(tableExists(reopened, "original")).toBe(true);
      expect(schemaReads()).toEqual([]);
      reopened.close();

      const replacementPath = path.join(root, "replacement.sqlite");
      const replacement = new DatabaseSync(replacementPath);
      replacement.exec("CREATE TABLE replacement (id); PRAGMA user_version = 2");
      replacement.close();
      renameSync(replacementPath, filename);
      const replaced = openDatabase("", true, filename);
      expect(tableExists(replaced, "replacement")).toBe(true);
      expect(tableExists(replaced, "original")).toBe(false);
      expect(schemaReads().length).toBeGreaterThan(0);
      const firstValidationCount = schemaReads().length;
      replaced.close();
      const replacementReopened = openDatabase("", true, filename);
      expect(tableExists(replacementReopened, "replacement")).toBe(true);
      expect(schemaReads()).toHaveLength(firstValidationCount);
    } finally {
      observation.restore();
    }
  });

  it("keeps a catalog capture private when a sibling publishes DDL before it returns", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-capture-race-"), "state.sqlite");
    using source = new DatabaseSync(filename);
    source.exec("PRAGMA journal_mode=WAL; CREATE TABLE original(id); PRAGMA user_version=1");
    const reader = openDatabase("", false, filename);
    const writer = openDatabase("", false, filename);
    // oxlint-disable-next-line typescript/unbound-method -- The hook invokes the native method with its original statement receiver.
    const readAll = StatementSync.prototype.all;
    const capture = vi.spyOn(StatementSync.prototype, "all").mockImplementationOnce(function (
      this: StatementSync,
    ) {
      const rows = readAll.call(this, {});
      expect(rows.some((row) => row.name === "original")).toBe(true);
      writer.exec("CREATE TABLE published(id); PRAGMA user_version=2");
      admitSqliteSchema(writer);
      return rows;
    });
    try {
      admitSqliteSchema(reader);
      expect(capture).toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      const later = openDatabase("", true, filename);
      for (const database of [reader, later]) {
        expect(getAdmittedSqliteSchemaFacts(database)?.userVersion).toBe(2);
        expect(tableExists(database, "published")).toBe(true);
      }
      expect(
        observation.queries.filter((sql) =>
          /sqlite_schema|user_version|schema_version/iu.test(sql),
        ),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
  });

  it.each(["existing", "missing"])(
    "does not bind an %s native open to a replacement's admitted identity",
    (initial) => {
      const root = tempDirs.make("openclaw-schema-open-race-");
      const filename = path.join(root, "state.sqlite");
      const replacementPath = path.join(root, "replacement.sqlite");
      if (initial === "existing") {
        openDatabase(undefined, true, filename).close();
      }
      openDatabase("CREATE TABLE replacement (id)", true, replacementPath).close();
      // oxlint-disable-next-line typescript/unbound-method -- The race hook calls the native method with its original receiver.
      const nativeLocation = DatabaseSync.prototype.location;
      const location = vi
        .spyOn(DatabaseSync.prototype, "location")
        .mockImplementationOnce(function (this: DatabaseSync) {
          renameSync(replacementPath, filename);
          return nativeLocation.call(this);
        });
      try {
        expect(() => openNodeSqliteDatabase(filename)).toThrow(
          /changed identity during native open/u,
        );
      } finally {
        location.mockRestore();
      }
    },
  );

  it("preserves native creation permissions and refuses missing read-only or existing-only sources", () => {
    const root = tempDirs.make("openclaw-schema-creation-options-");
    const previous = process.umask(0);
    try {
      const baseline = path.join(root, "native.sqlite");
      new DatabaseSync(baseline).close();
      const candidate = path.join(root, "candidate.sqlite");
      openNodeSqliteDatabase(candidate).close();
      expect(statSync(candidate).mode & 0o777).toBe(statSync(baseline).mode & 0o777);
      const readonly = path.join(root, "readonly.sqlite");
      expect(() => openNodeSqliteDatabase(readonly, { readOnly: true })).toThrow();
      expect(existsSync(readonly)).toBe(false);
      const existing = path.join(root, "existing.sqlite");
      expect(() => openNodeSqliteDatabase(`file:${existing}?mode=rw`)).toThrow();
      expect(existsSync(existing)).toBe(false);
      const deferred = path.join(root, "deferred.sqlite");
      const unopened = openNodeSqliteDatabase(deferred, { open: false });
      expect(existsSync(deferred)).toBe(false);
      unopened.open();
      unopened.close();
      expect(existsSync(deferred)).toBe(true);
    } finally {
      process.umask(previous);
    }
  });

  it("binds the replacement file when the same native handle is reopened", () => {
    const root = tempDirs.make("openclaw-schema-native-reopen-");
    const filename = path.join(root, "state.sqlite");
    const replacementPath = path.join(root, "replacement.sqlite");
    const database = openDatabase(undefined, true, filename);
    database.close();
    const replacement = new DatabaseSync(replacementPath);
    replacement.exec("CREATE TABLE replacement (id); PRAGMA user_version = 7");
    replacement.close();
    renameSync(replacementPath, filename);
    database.open();
    expect(tableExists(database, "original")).toBe(false);
    expect(tableExists(database, "replacement")).toBe(true);
    expect(getAdmittedSqliteSchemaFacts(database)?.userVersion).toBe(7);
  });

  it("publishes the final migration catalog without rechecking it on the next open", () => {
    const filename = path.join(
      tempDirs.make("openclaw-schema-migration-publication-"),
      "state.sqlite",
    );
    const database = openDatabase(undefined, true, filename);
    runSqliteImmediateTransactionSync(database, () => {
      database.exec("ALTER TABLE original ADD COLUMN first_added TEXT");
      expect(getAdmittedSqliteSchemaFacts(database)?.tableSql.get("original")).toContain(
        "first_added",
      );
      database.exec("ALTER TABLE original ADD COLUMN last_added TEXT");
    });
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      const sibling = openDatabase("", true, filename);
      expect(getAdmittedSqliteSchemaFacts(sibling)?.tableSql.get("original")).toContain(
        "last_added",
      );
      expect(
        observation.queries.filter((sql) =>
          /sqlite_schema|PRAGMA (?:user_version|schema_version)/iu.test(sql),
        ),
      ).toEqual([]);
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
    const peer = openNodeSqliteDatabase(filename);
    databases.push(peer);
    runSqliteReadOperationSync(database, () => {
      peer.exec(
        "CREATE TRIGGER unexpected_node_validation AFTER UPDATE ON session_nodes BEGIN SELECT 1; END",
      );
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

  it("retains table and column facts without statements after sibling data commits", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-data-"), "state.sqlite");
    const reader = openDatabase(
      "CREATE TABLE session_nodes (id INTEGER); PRAGMA user_version = 1;",
      true,
      filename,
    );
    reader.exec("PRAGMA journal_mode=WAL");
    const writer = openNodeSqliteDatabase(filename);
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
      expect(observation.queries).toHaveLength(0);
      expect(schemaMutation).not.toHaveBeenCalled();
    } finally {
      observation.restore();
    }
  });

  it("does not retain an expired snapshot's identity when adopting matching facts", () => {
    const database = openDatabase(undefined, false);
    const facts = runSqliteSchemaReadSnapshotSync(database, () => {
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
    const writer = openNodeSqliteDatabase(filename);
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
  it.each(["data_version", "schema_version", "user_version"])(
    "uses native freshness without consulting a table shadowing %s",
    (name) => {
      const database = openDatabase(
        `CREATE TABLE original (id); CREATE TABLE pragma_${name} (${name} INTEGER);
         INSERT INTO pragma_${name} VALUES (999); PRAGMA user_version = 1;`,
      );
      expect(runSqliteReadOperationSync(database, () => tableExists(database, "original"))).toBe(
        true,
      );
      expect(readSqliteDataVersion(database)).not.toBe(999);
    },
  );

  it.each(["transaction", "implicit snapshot"])(
    "refreshes foreign row commits while trusting admitted format through an active %s",
    (pin) => {
      const filename = path.join(tempDirs.make("openclaw-schema-foreign-"), "state.sqlite");
      const reader = openDatabase(undefined, true, filename);
      reader.exec("PRAGMA journal_mode=WAL");
      // An external writer changes rows without publishing process-owned schema facts.
      const writer = new DatabaseSync(filename);
      databases.push(writer);
      const schemaMutation = vi.fn();
      registerSqliteSchemaMutationListener(reader, schemaMutation);
      const rows = () =>
        runSqliteReadOperationSync(reader, () =>
          reader.prepare("SELECT id FROM original ORDER BY id").all(),
        );
      writer.exec(
        "BEGIN; INSERT INTO original VALUES (1); CREATE TABLE committed (id); PRAGMA user_version = 2; COMMIT;",
      );
      expect(rows()).toEqual([{ id: 1 }]);
      expect(tableExists(reader, "committed")).toBe(false);
      expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(1);

      const readSnapshot = () => {
        expect(rows()).toEqual([{ id: 1 }]);
        writer.exec("BEGIN; INSERT INTO original VALUES (2); PRAGMA user_version = 3; COMMIT;");
        expect(rows()).toEqual([{ id: 1 }]);
        expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(1);
        expect(schemaMutation).not.toHaveBeenCalled();
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
        runSqliteSchemaReadSnapshotSync(reader, readSnapshot);
      }
      expect(rows()).toEqual([{ id: 1 }, { id: 2 }]);
      expect(assertSupportedAgentSchemaVersion(reader, filename)).toBe(1);
      expect(schemaMutation).not.toHaveBeenCalled();
      writer.exec("PRAGMA user_version = 2147483647");
      expect(
        runSqliteReadOperationSync(reader, () =>
          assertSupportedAgentSchemaVersion(reader, filename),
        ),
      ).toBe(1);
    },
  );

  it("ends nested read scopes on exceptions and before async continuations", async () => {
    const filename = path.join(tempDirs.make("openclaw-schema-read-scope-"), "state.sqlite");
    const reader = openDatabase(undefined, false, filename);
    const revision = () => getSqliteReadOperationRevision(reader);
    const admission = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(() =>
        runSqliteReadOperationSync(reader, () => {
          admitSqliteSchema(reader);
          expect(revision()).toBeDefined();
          throw new Error("read failed");
        }),
      ).toThrow("read failed");
      expect(revision()).toBeUndefined();
      await runSqliteReadOperationSync(reader, async () => {
        expect(revision()).toBeDefined();
        await Promise.resolve();
        expect(revision()).toBeUndefined();
      });
      expect(admission.queries.filter((sql) => /data_version/iu.test(sql))).toEqual([]);
    } finally {
      admission.restore();
    }
  });

  it("invalidates warmed row revisions on sibling writes without querying data_version", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-write-receipt-"), "state.sqlite");
    const reader = openDatabase(undefined, true, filename);
    const writer = openDatabase("", true, filename);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      const revision = () =>
        runSqliteReadOperationSync(reader, () => getSqliteReadOperationRevision(reader));
      const before = revision();
      expect(before).toBeDefined();
      expect(revision()).toBe(before);
      writer.exec("BEGIN IMMEDIATE; INSERT INTO original VALUES (1)");
      expect(revision()).toBeUndefined();
      expect(readSqliteDatabaseWriteRevision(writer)).toBeTypeOf("number");
      const sibling = readSqliteDatabaseSiblingWriteRevision(writer);
      writer.exec("COMMIT");
      expect(readSqliteDatabaseSiblingWriteRevision(writer)).toBe(sibling);
      expect(revision()).not.toBe(before);
      expect(reader.prepare("SELECT id FROM original").all()).toEqual([{ id: 1 }]);
      const tracking = {
        kind: "generation",
        table: "local_status",
        triggers: [],
        advance: false,
      } as const;
      installSqliteTempTrackingSchema(writer, tracking);
      const committed = revision();
      writer.exec(
        'BEGIN; INSERT OR REPLACE INTO temp.local_status VALUES (1,1); UPDATE "temp".local_status SET generation=2; COMMIT',
      );
      expect(revision()).toBe(committed);
      writer.exec("BEGIN; INSERT INTO original VALUES (2); ROLLBACK");
      expect(revision()).not.toBe(committed);
      expect(reader.prepare("SELECT id FROM original").all()).toEqual([{ id: 1 }]);
      writer.exec(`
        CREATE TEMP TABLE local_status$extra (value);
        CREATE TEMP TRIGGER suffix_tracking_write AFTER INSERT ON local_status$extra
        BEGIN INSERT INTO original VALUES (NEW.value); END;
      `);
      const insertSuffix = writer.prepare("INSERT INTO temp.local_status$extra VALUES (8)");
      installSqliteTempTrackingSchema(writer, tracking);
      const beforeSuffix = revision();
      insertSuffix.run();
      expect(revision()).not.toBe(beforeSuffix);
      expect(reader.prepare("SELECT id FROM original").all()).toEqual([{ id: 1 }, { id: 8 }]);
      const updateTracking = writer.prepare("UPDATE temp.local_status SET generation=3");
      writer.exec(
        "CREATE TEMP TRIGGER custom_tracking_write AFTER UPDATE ON local_status BEGIN INSERT INTO original VALUES (9); END",
      );
      installSqliteTempTrackingSchema(writer, tracking);
      const beforeTrigger = revision();
      updateTracking.run();
      expect(revision()).not.toBe(beforeTrigger);
      expect(reader.prepare("SELECT id FROM original").all()).toEqual([
        { id: 1 },
        { id: 8 },
        { id: 9 },
      ]);
      expect(observation.queries.filter((sql) => /data_version/iu.test(sql))).toEqual([]);
    } finally {
      observation.restore();
    }
  });

  it("reuses rows only within their explicit snapshot and observes the next committed rows", () => {
    const filename = path.join(tempDirs.make("openclaw-row-snapshot-"), "state.sqlite");
    const reader = openDatabase(
      `
      PRAGMA journal_mode=WAL;
      CREATE TABLE session_participants (
        session_key TEXT, identity_namespace TEXT, actor_id TEXT,
        contribution_count INTEGER, first_prompted_at INTEGER, last_prompted_at INTEGER
      );
      INSERT INTO session_participants VALUES ('session', '{"type":"profile"}', 'first', 1, 1, 1);
    `,
      true,
      filename,
    );
    const writer = openDatabase("", true, filename);
    const read = () =>
      participantRecordsBySessionKey(reader, ["session"])
        .get("session")
        ?.map((row) => row.identity.id);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    const rowReads = () =>
      observation.queries.filter((sql) => /from "session_participants"/iu.test(sql)).length;
    try {
      expect(read()).toEqual(["first"]);
      runSqliteReadOperationSync(reader, () => {
        reader.exec("BEGIN");
        try {
          expect(read()).toEqual(["first"]);
          const reads = rowReads();
          writer.exec("UPDATE session_participants SET actor_id='second'");
          expect(read()).toEqual(["first"]);
          expect(rowReads()).toBe(reads);
          reader.exec("COMMIT; BEGIN");
          expect(read()).toEqual(["second"]);
        } finally {
          reader.exec("COMMIT");
        }
        expect(read()).toEqual(["second"]);
        writer.exec("UPDATE session_participants SET actor_id='third'");
        expect(read()).toEqual(["third"]);
      });
      runSqliteSchemaReadSnapshotSync(reader, () => {
        expect(read()).toEqual(["third"]);
        const reads = rowReads();
        writer.exec("UPDATE session_participants SET actor_id='fourth'");
        expect(read()).toEqual(["third"]);
        expect(rowReads()).toBe(reads);
      });
      expect(read()).toEqual(["fourth"]);
      expect(observation.queries.filter((sql) => /data_version/iu.test(sql))).toEqual([]);
    } finally {
      observation.restore();
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

    runSqliteSchemaReadSnapshotSync(reader, () => {
      writer.exec("CREATE TABLE implicit_snapshot (id)");
      expect(tableExists(reader, "implicit_snapshot")).toBe(false);
    });
    expect(tableExists(reader, "implicit_snapshot")).toBe(true);
    writer.exec("BEGIN; CREATE TABLE closed_rollback (id)");
    expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(true);
    writer.close();
    expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(false);
    expect(tableExists(reader, "closed_rollback")).toBe(false);
  });

  it.each([
    { method: "exec", implicitSnapshot: false, admittedBeforeBegin: true, rollback: "ROLLBACK" },
    { method: "iterate", implicitSnapshot: false, admittedBeforeBegin: true, rollback: "ROLLBACK" },
    { method: "exec", implicitSnapshot: true, admittedBeforeBegin: true, rollback: "ROLLBACK" },
    {
      method: "exec",
      implicitSnapshot: true,
      admittedBeforeBegin: true,
      rollback: "ROLLBACK; SELECT 1",
    },
    {
      method: "exec",
      implicitSnapshot: true,
      admittedBeforeBegin: true,
      rollback: "ROLLBACK; -- cleanup",
    },
    {
      method: "exec",
      implicitSnapshot: true,
      admittedBeforeBegin: true,
      rollback: "ROLLBACK; SELECT 'CREATE'",
    },
    { method: "exec", implicitSnapshot: true, admittedBeforeBegin: false, rollback: "ROLLBACK" },
  ] as const)(
    "keeps a sibling's committed catalog after a failed WAL upgrade and $method rollback, implicit pin=$implicitSnapshot, admitted=$admittedBeforeBegin, SQL=$rollback",
    ({ method, implicitSnapshot, admittedBeforeBegin, rollback }) => {
      const filename = path.join(tempDirs.make("openclaw-schema-busy-snapshot-"), "state.sqlite");
      const stale = openDatabase(undefined, admittedBeforeBegin, filename);
      stale.exec("PRAGMA journal_mode=WAL");
      const writer = openDatabase("", true, filename);
      const original = getAdmittedSqliteSchemaFacts(stale);
      let committed: ReturnType<typeof getAdmittedSqliteSchemaFacts>;
      let generation: number | undefined;
      const observation = observeSqliteReadSql(StatementSync.prototype);
      let rollbackStart = 0;
      const rollbackFailedUpgrade = () => {
        stale.exec("BEGIN");
        stale.prepare("SELECT id FROM original").all();
        writer.exec("CREATE TABLE committed_sibling (id); PRAGMA user_version=2");
        committed = getAdmittedSqliteSchemaFacts(writer);
        generation = getSqliteDatabaseSchemaRevision(writer);
        expect(committed?.userVersion).toBe(2);
        expect(generation).toEqual(expect.any(Number));
        let failure: unknown;
        try {
          stale.exec("CREATE TABLE rejected_upgrade (id)");
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ errcode: 517 });
        expect(stale.isTransaction).toBe(true);
        if (!admittedBeforeBegin) {
          admitSqliteSchema(stale);
        }
        rollbackStart = observation.queries.length;
        if (method === "exec") {
          stale.exec(rollback);
        } else {
          expect([...stale.prepare(rollback).iterate()]).toEqual([]);
        }
        if (implicitSnapshot) {
          if (admittedBeforeBegin) {
            expect(getAdmittedSqliteSchemaFacts(stale)?.admissionId).toBe(original?.admissionId);
          }
          expect(getAdmittedSqliteSchemaFacts(stale)?.userVersion).toBe(1);
          expect(getAdmittedSqliteSchemaFacts(stale)?.tables.has("committed_sibling")).toBe(false);
          expect(() => stale.prepare("SELECT id FROM committed_sibling").all()).toThrow(
            /no such table/iu,
          );
        }
        const reopened = openDatabase("", true, filename);
        for (const database of implicitSnapshot ? [writer, reopened] : [stale, writer, reopened]) {
          const facts = getAdmittedSqliteSchemaFacts(database);
          expect(facts?.admissionId).toBe(committed?.admissionId);
          expect(facts?.userVersion).toBe(2);
          expect(facts?.tables.has("committed_sibling")).toBe(true);
          expect(facts?.tables.has("rejected_upgrade")).toBe(false);
          expect(getSqliteDatabaseSchemaRevision(database)).toBe(generation);
        }
      };
      try {
        if (implicitSnapshot) {
          runSqliteSchemaReadSnapshotSync(stale, rollbackFailedUpgrade);
        } else {
          rollbackFailedUpgrade();
        }
        expect(getAdmittedSqliteSchemaFacts(stale)?.admissionId).toBe(committed?.admissionId);
        expect(getAdmittedSqliteSchemaFacts(stale)?.userVersion).toBe(2);
        expect(getAdmittedSqliteSchemaFacts(stale)?.tables.has("committed_sibling")).toBe(true);
        expect(getSqliteDatabaseSchemaRevision(stale)).toBe(generation);
        for (const pattern of [
          /sqlite_schema/iu,
          /PRAGMA user_version/iu,
          /PRAGMA schema_version/iu,
        ]) {
          expect(
            observation.queries.slice(rollbackStart).filter((sql) => pattern.test(sql)),
          ).toHaveLength(0);
        }
      } finally {
        observation.restore();
      }
    },
  );

  it("discards rolled-back staged catalog facts before transaction observers unwind", () => {
    const filename = path.join(
      tempDirs.make("openclaw-schema-rollback-publication-"),
      "state.sqlite",
    );
    const database = openDatabase(undefined, true, filename);
    const committed = getAdmittedSqliteSchemaFacts(database);
    const generation = getSqliteDatabaseSchemaRevision(database);
    const refusal = new Error("synthetic transaction refusal");
    const observation = observeSqliteReadSql(StatementSync.prototype);
    let rollbackStart = 0;
    try {
      expect(() =>
        withSqlitePostCommitPublications(database, () => {
          database.exec("BEGIN");
          database.exec("CREATE TABLE rolled_back (id); PRAGMA user_version=3");
          expect(getAdmittedSqliteSchemaFacts(database)?.tables.has("rolled_back")).toBe(true);
          rollbackStart = observation.queries.length;
          database.exec("ROLLBACK");
          expect(getAdmittedSqliteSchemaFacts(database)?.admissionId).toBe(committed?.admissionId);
          expect(getAdmittedSqliteSchemaFacts(database)?.tables.has("rolled_back")).toBe(false);
          throw refusal;
        }),
      ).toThrow(refusal);
      const reopened = openDatabase("", true, filename);
      expect(getAdmittedSqliteSchemaFacts(reopened)?.admissionId).toBe(committed?.admissionId);
      expect(getAdmittedSqliteSchemaFacts(reopened)?.userVersion).toBe(1);
      expect(getSqliteDatabaseSchemaRevision(reopened)).toBe(generation);
      expect(
        observation.queries
          .slice(rollbackStart)
          .filter((sql) => /sqlite_schema|PRAGMA (?:user_version|schema_version)/iu.test(sql)),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
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
