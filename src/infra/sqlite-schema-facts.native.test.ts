import { fstatSync, linkSync, renameSync } from "node:fs";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { readExistingAgentSchemaMeta } from "../state/openclaw-agent-db-metadata.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import { SqliteDatabaseAdmissionRegistry } from "./sqlite-database-admission-record.js";
import {
  captureSqliteDatabaseAdmissions as captureAdmissions,
  createSqliteDatabaseAdmissionCursor,
  installSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
  getSqliteDatabaseAdmission,
  getSqliteDatabaseSchemaRevision,
  publishSqliteDatabaseAdmission,
  readSqliteDatabaseWriteRevision,
  readSqliteDatabaseScopedWriteToken as scopedWriteToken,
  revokeSqliteDatabaseAdmissions,
  withSqliteDatabaseAdmissionExchange,
} from "./sqlite-database-admission.js";
import { createSqliteDatabaseWriteReceipts } from "./sqlite-database-write-receipts.js";
import { runSqliteSchemaReadSnapshotSync as withSchemaSnapshot } from "./sqlite-pinned-read-snapshot.js";
import { readSqliteTextEncoding, schemaAdmission } from "./sqlite-schema-admission.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts as admittedSchema,
  getSqliteReadOperationRevision,
  installSqliteTempTrackingSchema,
  registerSqliteSchemaMutationListener,
  runSqliteReadOperationSync as withReadOperation,
} from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";
import { runSqliteImmediateTransactionSync as withTransaction } from "./sqlite-transaction.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

describe("native SQLite schema snapshots and callbacks", () => {
  const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();
  const rowsSchema = "CREATE TABLE original(id); INSERT INTO original VALUES(1),(2)";
  const walSchema = `PRAGMA journal_mode=WAL; ${rowsSchema}; PRAGMA user_version=1`;
  function openPair(schema?: string, admitted = true) {
    const filename = path.join(tempDirs.make("sqlite-native-pair-"), "state.sqlite");
    return [openDatabase(schema, admitted, filename), openDatabase("", true, filename)] as const;
  }

  function observeReads(inspect: (queries: string[]) => void) {
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      inspect(observation.queries);
    } finally {
      observation.restore();
    }
  }

  function reuseCursor(database: DatabaseSync, ending: "completion" | "return") {
    const statement = database.prepare("SELECT id FROM original");
    const old = statement.iterate();
    old.next();
    if (ending === "completion") {
      old.next();
      old.next();
    } else {
      old.return?.();
    }
    const current = statement.iterate();
    current.next();
    old.return?.();
    return current;
  }

  it("does not retain the default encoding before the first schema object exists", () => {
    const filename = path.join(tempDirs.make("sqlite-empty-encoding-"), "agent.sqlite");
    const database = openDatabase("", true, filename);
    expect(admittedSchema(database)?.textEncoding).toBe("UTF-8");
    database.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE original(id)");
    expect(admittedSchema(database)?.textEncoding).toBe("UTF-16le");
    expect(readSqliteTextEncoding(database)).toBe("UTF-16le");
    database.close();
    expect(admittedSchema(openDatabase("", true, filename))?.textEncoding).toBe("UTF-16le");
  });

  it("observes a sibling commit while a new reader adopts retained schema facts", async () => {
    const databaseAdmission = await import("./sqlite-database-admission.js");
    const filename = path.join(tempDirs.make("sqlite-adoption-publication-"), "state.sqlite");
    const writer = openDatabase(undefined, true, filename);
    const readAdmission = databaseAdmission.getSqliteDatabaseAdmission;
    const adoption = vi.spyOn(databaseAdmission, "getSqliteDatabaseAdmission");
    adoption.mockImplementationOnce((database, key, options) => {
      const captured = readAdmission(database, key, options);
      // A worker can publish after the old catalog is read but before adoption returns.
      writer.exec("CREATE TABLE newly_committed (value); INSERT INTO newly_committed VALUES (42)");
      return captured;
    });
    try {
      const reader = openDatabase("", true, filename);
      expect(reader.prepare("SELECT value FROM newly_committed").all()).toEqual([{ value: 42 }]);
      expect(tableExists(reader, "newly_committed")).toBe(true);
    } finally {
      adoption.mockRestore();
    }
  });

  it("publishes the next write after cold writer discovery throws", () => {
    const filename = path.join(tempDirs.make("sqlite-custody-recovery-"), "agent.sqlite");
    {
      using initial = new DatabaseSync(filename);
      initial.exec("CREATE TABLE proof (value INTEGER NOT NULL)");
    }
    const writer = openDatabase("", false, filename);
    expect(() =>
      withSqliteDatabaseAdmissionExchange(
        () => {
          throw new Error("synthetic writer discovery refusal");
        },
        () => writer.exec("INSERT INTO proof VALUES (1)"),
      ),
    ).toThrow("synthetic writer discovery refusal");

    // Admitting the sibling earlier would warm the writer discovery this case exercises.
    const sibling = openDatabase("", true, filename);
    const before = scopedWriteToken(sibling, "session");
    expect(before).toBeTypeOf("string");
    expect(sibling.prepare("SELECT value FROM proof").all()).toEqual([]);

    writer.exec("INSERT INTO proof VALUES (2)");
    expect(sibling.prepare("SELECT value FROM proof").all()).toEqual([{ value: 2 }]);
    const committed = scopedWriteToken(sibling, "session");
    expect(committed).toBeTypeOf("string");
    expect(committed).not.toBe(before);
  });

  it.each(["autocommit", "commit", "rollback", "callback failure"] as const)(
    "settles %s writes while an unrelated read cursor remains open",
    (outcome) => {
      const [writer, sibling] = openPair(`PRAGMA journal_mode=WAL; ${rowsSchema}`);
      const before = scopedWriteToken(sibling, "session");
      expect(before).toBeTypeOf("string");
      const rows = writer.prepare("SELECT id FROM original").iterate();
      try {
        expect(rows.next().done).toBe(false);
        if (outcome === "callback failure") {
          expect(() =>
            withTransaction(writer, () => {
              writer.exec("INSERT INTO original VALUES (3)");
              throw new Error("synthetic transaction conflict");
            }),
          ).toThrow("synthetic transaction conflict");
        } else {
          if (outcome !== "autocommit") {
            writer.exec("BEGIN IMMEDIATE");
          }
          writer.exec("INSERT INTO original VALUES (3)");
          if (outcome !== "autocommit") {
            writer.exec(outcome === "commit" ? "COMMIT" : "ROLLBACK");
          }
        }
        // Native write custody is gone even though the independent SELECT remains stepped.
        sibling.exec("BEGIN IMMEDIATE; ROLLBACK");
        expect(sibling.prepare("SELECT id FROM original ORDER BY id").all()).toEqual(
          outcome === "rollback" || outcome === "callback failure"
            ? [{ id: 1 }, { id: 2 }]
            : [{ id: 1 }, { id: 2 }, { id: 3 }],
        );
        const settled = scopedWriteToken(sibling, "session");
        expect(settled).toBeTypeOf("string");
        expect(settled).not.toBe(before);
      } finally {
        rows.return?.();
      }
    },
  );

  it("settles a RETURNING writer when its own cursor closes", () => {
    const [writer, sibling] = openPair(`PRAGMA journal_mode=WAL; ${rowsSchema}`);
    const reader = writer.prepare("SELECT id FROM original").iterate();
    const write = writer.prepare("INSERT INTO original VALUES (3),(4) RETURNING id").iterate();
    try {
      expect(reader.next().done).toBe(false);
      expect(write.next().value).toEqual({ id: 3 });
      writer.prepare("SELECT 1").get();
      expect(() => sibling.exec("BEGIN IMMEDIATE")).toThrow(/locked/iu);
      write.return?.();
      sibling.exec("BEGIN IMMEDIATE; ROLLBACK");
      expect(scopedWriteToken(sibling, "session")).toBeTypeOf("string");
      expect(sibling.prepare("SELECT id FROM original ORDER BY id").all()).toEqual([
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4 },
      ]);
    } finally {
      write.return?.();
      reader.return?.();
    }
  });

  it("reuses admission publications until their owner changes them", () => {
    const root = tempDirs.make("openclaw-admission-publications-");
    const first = openDatabase(
      "CREATE TABLE first_value(id)",
      true,
      path.join(root, "first.sqlite"),
    );
    const second = openDatabase(
      "CREATE TABLE second_value(id)",
      true,
      path.join(root, "second.sqlite"),
    );
    const existingToken = scopedWriteToken(second, "existing");
    const cursor = createSqliteDatabaseAdmissionCursor();
    const before = captureAdmissions(cursor);
    const firstSnapshot = before.find((record) => record.location === first.location())!;
    const secondSnapshot = before.find((record) => record.location === second.location())!;
    const key = { name: "publication-value", read: (value: unknown) => value };

    const inherited = getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY);
    installSqliteDatabaseAdmissions([]);
    expect(captureAdmissions(cursor)).toEqual([]);
    expect(getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY)).toBe(inherited);

    installSqliteDatabaseAdmissions(structuredClone(before));
    expect(captureAdmissions(cursor)).toEqual([]);
    expect(getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY)).toBe(inherited);
    expect(captureAdmissions().find((record) => record.identity === firstSnapshot.identity)).toBe(
      firstSnapshot,
    );

    publishSqliteDatabaseAdmission(second, key, 42);
    const changed = captureAdmissions(cursor);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.identity).toBe(secondSnapshot.identity);
    expect(changed[0]!.facts.get(key.name)?.value).toBe(42);
    expect([...changed[0]!.facts.keys()]).toEqual([key.name]);
    expect(changed[0]!.writeScopes.size).toBe(0);
    expect(changed[0]!.references.size).toBe(0);
    expect(getSqliteDatabaseAdmission(second, key)).toBe(42);
    expect(secondSnapshot.facts.has(key.name)).toBe(false);
    expect(captureAdmissions().find((record) => record.identity === firstSnapshot.identity)).toBe(
      firstSnapshot,
    );
    expect(captureAdmissions(cursor)).toEqual([]);

    scopedWriteToken(second, "new");
    const [scopes] = captureAdmissions(cursor);
    expect([...scopes!.writeScopes.keys()]).toEqual(['["key","new"]']);
    expect(scopes!.facts.size).toBe(0);
    expect(scopes!.references.size).toBe(0);
    // Scope maps are lazy: discovery and receiver installation must not mutate the old capture.
    expect([...structuredClone(secondSnapshot).writeScopes.keys()]).toEqual(['["key","existing"]']);
    expect(scopedWriteToken(second, "existing")).toBe(existingToken);
    const receiver = new SqliteDatabaseAdmissionRegistry();
    receiver.install([secondSnapshot]);
    receiver.install([scopes!]);
    expect([...secondSnapshot.writeScopes.keys()]).toEqual(['["key","existing"]']);
    expect([...receiver.capture()[0]!.writeScopes.keys()].toSorted()).toEqual([
      '["key","existing"]',
      '["key","new"]',
    ]);
    const fresh = captureAdmissions(createSqliteDatabaseAdmissionCursor()).find(
      (record) => record.identity === secondSnapshot.identity,
    )!;
    expect(fresh.writeScopes.size).toBe(2);
    expect(fresh.facts.get(key.name)?.value).toBe(42);

    revokeSqliteDatabaseAdmissions(second);
    installSqliteDatabaseAdmissions([]);
    expect(getSqliteDatabaseAdmission(second, key)).toBeUndefined();
    installSqliteDatabaseAdmissions(changed);
    expect(getSqliteDatabaseAdmission(second, key)).toBeUndefined();
    expect(captureAdmissions(cursor)).toEqual([]);
    const secondLocation = second.location()!;
    second.close();
    retireSqliteDatabaseAdmissionForPath(secondLocation);
    expect(captureAdmissions().some((record) => record.identity === secondSnapshot.identity)).toBe(
      false,
    );
  });

  it("reclaims another isolate's retired metadata at the next publication", () => {
    const root = tempDirs.make("sqlite-retired-publication-");
    const first = openDatabase("CREATE TABLE proof(value)", true, path.join(root, "first.sqlite"));
    const second = openDatabase(
      "CREATE TABLE proof(value)",
      true,
      path.join(root, "second.sqlite"),
    );
    const firstSnapshot = captureAdmissions(undefined, {
      location: first.location()!,
    })[0]!;
    const secondSnapshot = captureAdmissions(undefined, {
      location: second.location()!,
    })[0]!;
    const receiver = new SqliteDatabaseAdmissionRegistry();
    receiver.install(structuredClone([firstSnapshot, secondSnapshot]));
    try {
      first.close();
      receiver.publish(receiver.records.get(secondSnapshot.identity)!);
      expect(receiver.records.has(firstSnapshot.identity)).toBe(false);
    } finally {
      captureAdmissions();
    }
  });

  it("installs a recreated scope when only the sender's latest publication is delivered", () => {
    const location = path.join(tempDirs.make("sqlite-recreated-scope-"), "proof.sqlite");
    const database = openDatabase("CREATE TABLE proof(value)", true, location);
    const original = scopedWriteToken(database, "reused");
    const [snapshot] = captureAdmissions(undefined, { location });
    const sender = new SqliteDatabaseAdmissionRegistry();
    sender.install(structuredClone([snapshot!]));
    const receipts = createSqliteDatabaseWriteReceipts({
      admission: () => sender.records.get(snapshot!.identity),
      pathAdmission: () => sender.records.get(snapshot!.identity),
      retain: () => {},
      release: () => {},
      writeListeners: new WeakMap(),
      readRevision: () => 0,
      writer: () => sender.records.get(snapshot!.identity),
      suspended: () => false,
      publish: (record) => sender.publish(record),
    });
    try {
      receipts.retireSqliteDatabaseWriteScopes(database, ["reused"]);
      const replacement = receipts.scopedWriteToken(database, "reused");
      expect(replacement).toBeTypeOf("string");
      expect(replacement).not.toBe(original);

      installSqliteDatabaseAdmissions(structuredClone(sender.capture()));
      expect(scopedWriteToken(database, "reused")).toBe(replacement);
    } finally {
      // The synthetic sender's environment publication must not replace the process owner.
      captureAdmissions();
    }
  });

  it.each(["scoped", "full"] as const)(
    "keeps other database publications pending for the next %s capture",
    (nextCapture) => {
      const cursor = createSqliteDatabaseAdmissionCursor();
      // Other cases retain process-wide admissions; acknowledge those before creating this pair.
      captureAdmissions(cursor);
      const root = tempDirs.make("openclaw-admission-scoped-cursor-");
      const first = path.join(root, "first.sqlite");
      const second = path.join(root, "second.sqlite");
      const firstDatabase = openDatabase(undefined, true, first);
      const secondDatabase = openDatabase(undefined, true, second);

      expect(
        captureAdmissions(cursor, { location: first }).map((record) => record.location),
      ).toEqual([firstDatabase.location()]);
      expect(
        captureAdmissions(cursor, nextCapture === "scoped" ? { location: second } : undefined).map(
          (record) => record.location,
        ),
      ).toEqual([secondDatabase.location()]);
      expect(captureAdmissions(cursor)).toEqual([]);
    },
  );

  it.each([
    "CREATE TEMP TABLE other_input (id)",
    'DROP TABLE [temp]."memory_publication_input$extra"',
  ])("retains MAIN admission while revoking local TEMP facts: %s", (sql) => {
    const filename = path.join(tempDirs.make("openclaw-schema-temp-"), "state.sqlite");
    const database = openDatabase(
      `CREATE TABLE original(id);
       CREATE TEMP TABLE memory_publication_input(id);
       CREATE TEMP TABLE memory_publication_input$extra(id)`,
      true,
      filename,
    );
    installSqliteTempTrackingSchema(database, {
      statusTable: "local_status",
      pendingTable: "local_pending",
      pendingIndex: "local_pending_state",
      observedTables: [],
    });
    const schema = admittedSchema(database);
    const localRevision = () =>
      withReadOperation(database, () => getSqliteReadOperationRevision(database));
    const beforeLocal = localRevision();
    expect(beforeLocal).toBeDefined();
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(database, schemaMutation);
    observeReads((queries) => {
      database.exec(sql);
      expect(localRevision()).not.toBe(beforeLocal);
      expect(admittedSchema(database)?.admissionId).toBe(schema?.admissionId);
      const sibling = openDatabase("", true, filename);
      expect(admittedSchema(sibling)?.admissionId).toBe(schema?.admissionId);
      expect(schemaMutation).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
      const beforeWrite = readSqliteDatabaseWriteRevision(sibling);
      database.exec("UPDATE temp.local_status SET sibling_write_revision=1");
      expect(readSqliteDatabaseWriteRevision(sibling)).not.toBe(beforeWrite);
    });
  });

  it("retains no descriptor for raw snapshot opens and retires admitted snapshot custody", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-retirement-"), "snapshot.sqlite");
    const source = new DatabaseSync(filename);
    source.exec("CREATE TABLE original (id)");
    source.close();
    const inspection = openNodeSqliteDatabase(filename, { readOnly: true });
    try {
      inspection.exec("BEGIN");
      expect(inspection.prepare("SELECT id FROM original").all()).toEqual([]);
      inspection.exec("COMMIT");
    } finally {
      inspection.close();
    }
    const database = openDatabase("", false, filename);
    const location = database.location()!;
    expect(captureAdmissions().some((record) => record.location === location)).toBe(false);
    admitSqliteSchema(database);
    const record = captureAdmissions().find((entry) => entry.location === location)!;
    expect(fstatSync(record.descriptor).isFile()).toBe(true);
    const staleTransfer = structuredClone([record]);
    database.close();
    retireSqliteDatabaseAdmissionForPath(filename);
    expect(() => fstatSync(record.descriptor)).toThrow();
    installSqliteDatabaseAdmissions(staleTransfer);
    expect(captureAdmissions().some((entry) => entry.identity === record.identity)).toBe(false);
  });

  it("does not retire canonical admission through a snapshot hardlink", () => {
    const root = tempDirs.make("openclaw-schema-hardlink-");
    const filename = path.join(root, "state.sqlite");
    const database = openDatabase(undefined, true, filename);
    const snapshot = path.join(root, "snapshot.sqlite");
    linkSync(filename, snapshot);
    const record = captureAdmissions().find((entry) => entry.location === database.location())!;
    retireSqliteDatabaseAdmissionForPath(snapshot);
    expect(fstatSync(record.descriptor).isFile()).toBe(true);
    expect(tableExists(database, "original")).toBe(true);
  });

  it.for([false, true])(
    "discards raw savepoint row receipts without DDL: schemaDependent=%s",
    (schemaDependent) => {
      const [database, sibling] = openPair(
        "CREATE TABLE original(id); INSERT INTO original VALUES(1)",
      );
      const key = {
        name: "row-backed-admission",
        schemaDependent,
        read: (value: unknown) => (typeof value === "number" ? value : undefined),
      };
      publishSqliteDatabaseAdmission(database, key, 1);
      withTransaction(database, () => {
        database.exec("UPDATE original SET id=2");
        publishSqliteDatabaseAdmission(database, key, 2);
        database.exec("SAVEPOINT s; UPDATE original SET id=3");
        publishSqliteDatabaseAdmission(database, key, 3);
        expect(getSqliteDatabaseAdmission(database, key)).toBe(3);
        database.exec("ROLLBACK TO s; RELEASE s");
        expect(getSqliteDatabaseAdmission(database, key)).toBeUndefined();
        expect(database.prepare("SELECT id FROM original").get()?.id).toBe(2);
      });
      expect(getSqliteDatabaseAdmission(sibling, key)).toBeUndefined();
      withTransaction(database, () => {
        publishSqliteDatabaseAdmission(database, key, 2);
        expect(getSqliteDatabaseAdmission(database, key)).toBe(2);
      });
      expect(getSqliteDatabaseAdmission(sibling, key)).toBe(2);
    },
  );

  it("revokes catalog and schema-dependent receipts rolled back by raw savepoints", () => {
    const [database, sibling] = openPair("CREATE TABLE original(id)");
    const key = {
      name: "savepoint-table-ready",
      schemaDependent: true,
      read: (value: unknown) => (value === true ? true : undefined),
    };
    withTransaction(database, () => {
      database.exec("SAVEPOINT s");
      database.exec("CREATE TABLE rolled_back(id)");
      expect(admittedSchema(database)?.tables.has("rolled_back")).toBe(true);
      publishSqliteDatabaseAdmission(database, key, true);
      expect(getSqliteDatabaseAdmission(database, key)).toBe(true);
      database.exec("ROLLBACK TO s");
      expect(getSqliteDatabaseAdmission(database, key)).toBeUndefined();
      expect(getSqliteDatabaseAdmission(database, schemaAdmission)).toBeUndefined();
      database.exec("RELEASE s");
    });
    expect(getSqliteDatabaseAdmission(sibling, key)).toBeUndefined();
    expect(tableExists(sibling, "rolled_back")).toBe(false);
    expect(() => sibling.prepare("SELECT * FROM rolled_back")).toThrow("no such table");
  });

  it.for([
    { sql: "SAVEPOINT s; SELECT * FROM original", admitted: true },
    { sql: "BEGIN; SELECT * FROM original; SELECT * FROM missing", admitted: true },
    { sql: "BEGIN; SELECT * FROM original", admitted: false },
  ])("qualifies the raw control batch $sql (admitted=$admitted)", ({ sql, admitted }) => {
    const [reader, writer] = openPair(
      "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES(1); PRAGMA user_version=1",
      admitted,
    );
    if (sql.includes("missing")) {
      expect(() => reader.exec(sql)).toThrow("no such table");
    } else {
      reader.exec(sql);
    }
    expect(reader.isTransaction).toBe(true);
    writer.exec("CREATE TABLE committed_sibling(id); PRAGMA user_version=2");
    const committed = admittedSchema(writer);
    expect(reader.prepare("SELECT id FROM original").all()).toEqual([{ id: 1 }]);
    admitSqliteSchema(reader);
    expect(admittedSchema(reader)?.userVersion).toBe(1);
    expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(tableExists(reader, "committed_sibling")).toBe(false);
    reader.exec("COMMIT");
    expect(admittedSchema(reader)?.admissionId).toBe(committed?.admissionId);
  });

  it("settles abandoned native statements without retaining writer custody", async ({ signal }) => {
    const root = tempDirs.make("openclaw-schema-statement-retention-");
    const result = await runNodeScript(
      (workerArgv) => [
        "--expose-gc",
        ...workerArgv(resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.sqliteSchemaRetention)),
        root,
      ],
      { ...process.env, NODE_OPTIONS: "" },
      undefined,
      { signal, requireProcessTreeExit: process.platform !== "win32", maxBuffer: 64 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ collected: 4, pending: false });
  });

  it.for([
    { sql: "SELECT id FROM original", finish: "return", version: 1 },
    { sql: "SELECT id FROM original", finish: "complete", version: 1 },
    { sql: "SELECT id FROM original", finish: "all", version: 1 },
    { sql: "SELECT id FROM original", finish: "close", version: 1 },
    { sql: "SELECT id FROM original", finish: "dispose", version: 1 },
    { sql: "SELECT id FROM original", finish: "database close", version: 1 },
    { sql: "SELECT 1", finish: "return", version: 2 },
  ] as const)(
    "keeps ordinary iterator facts native-local: $sql, $finish",
    ({ sql, finish, version }, context) => {
      if (finish === "close" && typeof StatementSync.prototype.close !== "function") {
        context.skip();
      }
      if (finish === "dispose" && typeof StatementSync.prototype[Symbol.dispose] !== "function") {
        context.skip();
      }
      const [reader, writer] = openPair(walSchema);
      const statement = reader.prepare(sql);
      const rows = statement.iterate();
      try {
        expect(rows.next().done).toBe(false);
        writer.exec("CREATE TABLE committed_sibling(id); PRAGMA user_version=2");
        const committed = admittedSchema(writer);
        observeReads((queries) => {
          expect(admittedSchema(reader)?.userVersion).toBe(version);
          expect(tableExists(reader, "committed_sibling")).toBe(version === 2);
          // Schema capture retains the physical encoding across native snapshots.
          expect(queries).toHaveLength(3);
        });
        expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
        const visible =
          reader.prepare("SELECT name FROM sqlite_schema WHERE name='committed_sibling'").get() !==
          undefined;
        expect(visible).toBe(version === 2);
        expect(admittedSchema(writer)?.admissionId).toBe(committed?.admissionId);
        if (finish === "return") {
          rows.return?.();
        } else if (finish === "complete") {
          expect([...rows]).toHaveLength(1);
        } else if (finish === "database close") {
          reader.close();
          reader.open();
        } else if (finish === "dispose") {
          statement[Symbol.dispose]?.();
        } else {
          statement[finish]?.();
        }
        observeReads((queries) => {
          expect(admittedSchema(reader)?.admissionId).toBe(committed?.admissionId);
          expect(queries).toEqual([]);
        });
        reader.exec("CREATE TABLE after_reset(value)");
        expect(tableExists(writer, "after_reset")).toBe(true);
        if (finish !== "return" && finish !== "complete") {
          expect(() => rows.next()).toThrow(/invalidated|finalized/iu);
        }
      } finally {
        if (finish !== "close" && finish !== "dispose" && finish !== "database close") {
          rows.return?.();
        }
      }
    },
  );

  it.for(["iterate", "all", "exec"] as const)(
    "keeps callback captures inside the native %s snapshot",
    (method) => {
      const [reader, writer] = openPair(
        "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES(1); PRAGMA user_version=1",
      );
      reader.function("read_catalog", () => {
        writer.exec("CREATE TABLE added(id); PRAGMA user_version=2");
        expect(admittedSchema(reader)?.userVersion).toBe(1);
        expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
        expect(tableExists(reader, "added")).toBe(false);
        return 1;
      });
      const sql = "SELECT id, read_catalog() FROM original";
      if (method === "iterate") {
        const rows = reader.prepare(sql).iterate();
        try {
          expect(rows.next().done).toBe(false);
        } finally {
          rows.return?.();
        }
      } else if (method === "exec") {
        reader.exec(sql);
      } else {
        reader.prepare(sql)[method]();
      }
      observeReads((queries) => {
        expect(admittedSchema(reader)?.userVersion).toBe(2);
        expect(admittedSchema(writer)?.userVersion).toBe(2);
        expect(queries).toEqual([]);
      });
    },
  );

  it("observes completed DDL iterator replay according to the native runtime", () => {
    let expected: boolean;
    {
      using native = new DatabaseSync(":memory:");
      const control = native.prepare("DROP TABLE IF EXISTS target").iterate();
      control.next();
      native.exec("CREATE TABLE target(id)");
      control.next();
      expected =
        native.prepare("SELECT name FROM sqlite_schema WHERE name='target'").get() !== undefined;
      control.return?.();
    }
    const [writer, reader] = openPair();
    const rows = writer.prepare("DROP TABLE IF EXISTS target").iterate();
    try {
      expect(rows.next().done).toBe(true);
      writer.exec("CREATE TABLE target(id)");
      expect(tableExists(reader, "target")).toBe(true);
      rows.next();
      expect(tableExists(reader, "target")).toBe(expected);
      expect(
        reader.prepare("SELECT name FROM sqlite_schema WHERE name='target'").get() !== undefined,
      ).toBe(expected);
    } finally {
      rows.return?.();
    }
  });

  it.for(["completion", "return"] as const)(
    "preserves native return after %s without losing newer cursor custody",
    (ending) => {
      let expected: unknown;
      {
        using native = new DatabaseSync(":memory:");
        native.exec(rowsSchema);
        const current = reuseCursor(native, ending);
        expected = current.next().value?.id;
        current.return?.();
      }
      const [writer, reader] = openPair(`PRAGMA journal_mode=WAL; ${rowsSchema}`);
      const current = reuseCursor(writer, ending);
      try {
        if (expected === 1) {
          writer.exec("CREATE TABLE after_return(id)");
        }
        expect(current.next().value?.id).toBe(expected);
      } finally {
        current.return?.();
      }
      if (expected === 1) {
        expect(tableExists(reader, "after_return")).toBe(true);
      }
    },
  );

  it("binds iterators eagerly while retaining native prototype and result semantics", () => {
    const database = openDatabase();
    using native = new DatabaseSync(":memory:");
    let value = 1;
    let bindings = 0;
    let steps = 0;
    database.function("observe_step", () => ++steps);
    const rows = database.prepare("SELECT $value AS value, observe_step() AS step").iterate({
      get $value() {
        bindings += 1;
        return value;
      },
    });
    const control = native.prepare("SELECT 1").iterate();
    try {
      expect(bindings).toBe(1);
      expect(steps).toBe(0);
      expect(Object.getPrototypeOf(rows)).toBe(Object.getPrototypeOf(control));
      expect(rows[Symbol.iterator]()).toBe(rows);
      value = 2;
      const first = rows.next();
      expect(first.value).toEqual({ value: 1, step: 1 });
      expect(Object.getPrototypeOf(first)).toBe(Object.getPrototypeOf(control.next()));
      expect(rows.next()).toEqual(control.next());
      expect(rows.return?.()).toEqual(control.return?.());
      expect(bindings).toBe(1);
    } finally {
      rows.return?.();
      control.return?.();
    }
  });

  it("resets eagerly without retaining custody for unstepped iterators", () => {
    const schema = rowsSchema;
    using native = new DatabaseSync(":memory:");
    native.exec(schema);
    const control = native.prepare("SELECT id FROM original");
    const previous = control.iterate();
    previous.next();
    const next = control.iterate();
    next.next();
    previous.return?.();
    const expected = next.next().value;
    next.return?.();
    const [reader, sibling] = openPair(walSchema);
    const statement = reader.prepare("SELECT id FROM original");
    const old = statement.iterate();
    old.next();
    const current = statement.iterate();
    try {
      expect(() => old.next()).toThrow(/invalidated/iu);
      reader.exec("CREATE TABLE while_unstepped(id)");
      expect(tableExists(sibling, "while_unstepped")).toBe(true);
      expect(current.next().value).toEqual({ id: 1 });
      // Preserve the runtime's obsolete-cursor return behavior without losing schema facts.
      old.return?.();
      reader.exec("CREATE TABLE after_old_return(id)");
      expect(current.next().value).toEqual(expected);
    } finally {
      current.return?.();
      old.return?.();
    }
    expect(tableExists(sibling, "after_old_return")).toBe(true);
  });

  it.skipIf(typeof StatementSync.prototype.close !== "function")(
    "preserves an iterator when native statement reuse is refused before reset",
    () => {
      const [reader, writer] = openPair(walSchema);
      let refused = false;
      reader.function("reenter", (value) => {
        if (value === 2) {
          expect(() => statement.get({ unknown: 1 })).toThrow(
            "statement is already being executed",
          );
          refused = true;
        }
        return value;
      });
      const statement = reader.prepare("SELECT id, reenter(id) FROM original");
      const rows = statement.iterate();
      try {
        expect(rows.next().done).toBe(false);
        expect(rows.next().done).toBe(false);
        expect(refused).toBe(true);
        writer.exec("CREATE TABLE committed_sibling(id); PRAGMA user_version=2");
        expect(tableExists(reader, "committed_sibling")).toBe(false);
        expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      } finally {
        rows.return?.();
      }
      expect(tableExists(reader, "committed_sibling")).toBe(true);
    },
  );

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "keeps raw-handle metadata bound to native identity and authorizer policy",
    () => {
      const directory = tempDirs.make("openclaw-schema-unbound-");
      const filename = path.join(directory, "agent.sqlite");
      const replacement = path.join(directory, "replacement.sqlite");
      const schema = (
        agentId: string,
      ) => `CREATE TABLE schema_meta(meta_key,role,schema_version,agent_id);
      INSERT INTO schema_meta VALUES('primary','agent',1,'${agentId}')`;
      const original = openDatabase(schema("original"), true, filename);
      expect(readExistingAgentSchemaMeta(original)?.agentId).toBe("original");
      using raw = new DatabaseSync(filename);
      expect(raw.prepare("SELECT agent_id FROM schema_meta").get()?.agent_id).toBe("original");
      const replaced = openDatabase(schema("replacement"), true, replacement);
      expect(readExistingAgentSchemaMeta(replaced)?.agentId).toBe("replacement");
      let deniedFilename = filename;
      if (process.platform === "win32") {
        // Windows refuses replacing an open SQLite file; both handles keep their identity.
        expect(() => renameSync(replacement, filename)).toThrow(
          expect.objectContaining({ code: "EBUSY" }),
        );
        deniedFilename = replacement;
      } else {
        renameSync(replacement, filename);
      }
      expect(readExistingAgentSchemaMeta(raw)?.agentId).toBe("original");
      expect(readExistingAgentSchemaMeta(replaced)?.agentId).toBe("replacement");
      using denied = new DatabaseSync(deniedFilename);
      denied.setAuthorizer((action, table) =>
        action === constants.SQLITE_READ && table === "schema_meta"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      expect(() => readExistingAgentSchemaMeta(denied)).toThrow(/prohibited|authorized/iu);
    },
  );

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "tracks DDL custody and shared catalog changes while an authorizer is installed",
    () => {
      const [writer, sibling] = openPair();
      const revision = getSqliteDatabaseSchemaRevision(sibling)!;
      let observed = false;
      writer.function("observe_pending", () => {
        observed = true;
        return 1;
      });
      writer.setAuthorizer(() => constants.SQLITE_OK);
      writer.exec("CREATE TABLE authorized_table(value); SELECT observe_pending()");
      expect(observed).toBe(true);
      expect(getSqliteDatabaseSchemaRevision(sibling)).toBeGreaterThan(revision);
      writer.setAuthorizer(null);
      expect(admittedSchema(writer)?.tables.has("authorized_table")).toBe(true);
      expect(admittedSchema(sibling)?.tables.has("authorized_table")).toBe(true);
      writer.setAuthorizer((action) =>
        action === constants.SQLITE_CREATE_TABLE ? constants.SQLITE_DENY : constants.SQLITE_OK,
      );
      expect(() => writer.exec("CREATE TABLE denied_table(value)")).toThrow(/authorized/iu);
      writer.setAuthorizer(null);
      expect(admittedSchema(sibling)?.tables.has("denied_table")).toBe(false);
    },
  );

  it.each([
    ["raw", false, "SELECT id FROM original", 1, false],
    ["raw", true, "SELECT id FROM original", 1, false],
    ["raw", true, undefined, 2, false],
    ["raw", true, "SELECT 1", 2, false],
    ["managed", true, "SELECT id FROM original", 1, false],
    ["managed", true, "SELECT 1", 2, false],
    ["managed", true, "PRAGMA busy_timeout", 2, false],
    ["managed", true, "PRAGMA query_only", 2, false],
    ["managed", true, "SELECT id FROM original", 1, true],
  ] as const)(
    "qualifies %s snapshots: admitted=%s, read=%s, version=%i, pinned=%s",
    (mode, admitted, read, version, pinned) => {
      const filename = path.join(tempDirs.make("sqlite-snapshot-qualification-"), "state.sqlite");
      const reader = openDatabase(undefined, admitted, filename);
      reader.exec("PRAGMA journal_mode=WAL");
      const writer = openDatabase("", true, filename);
      reader.exec("BEGIN");
      let committed: ReturnType<typeof admittedSchema>;
      const inspect = () => {
        if (read) {
          reader.prepare(read).all();
        }
        writer.exec("CREATE TABLE committed_sibling (id); PRAGMA user_version=2");
        committed = admittedSchema(writer);
        if (mode === "raw") {
          admitSqliteSchema(reader);
        }
        if (pinned) {
          withSchemaSnapshot(reader, () => reader.prepare("SELECT id FROM original").all());
        }
        const verify = (queries?: string[]) => {
          const qualified = admittedSchema(reader);
          expect(qualified?.userVersion).toBe(version);
          expect(qualified?.tables.has("committed_sibling")).toBe(version === 2);
          if (queries) {
            const before = [...queries];
            expect(before.filter((query) => query.includes("sqlite_schema"))).toHaveLength(1);
            expect(admittedSchema(reader)).toBe(qualified);
            expect(queries).toEqual(before);
          }
        };
        if (mode === "managed") {
          observeReads(verify);
        } else {
          verify();
        }
        expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
        expect(admittedSchema(writer)?.admissionId).toBe(committed?.admissionId);
      };
      if (mode === "managed") {
        withReadOperation(reader, inspect);
      } else {
        inspect();
      }
      reader.exec("ROLLBACK");
      if (mode === "raw") {
        expect(admittedSchema(reader)?.admissionId).toBe(committed?.admissionId);
      } else {
        withSchemaSnapshot(reader, () => {
          expect(admittedSchema(reader)?.userVersion).toBe(2);
          expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
        });
      }
    },
  );
});
