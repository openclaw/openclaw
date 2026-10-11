import { fstatSync, linkSync, renameSync } from "node:fs";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { readExistingAgentSchemaMeta } from "../state/openclaw-agent-db-metadata.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  createSqliteDatabaseAdmissionCursor,
  installSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
  getSqliteDatabaseAdmission,
  getSqliteDatabaseSchemaRevision,
  hasPendingSqliteDatabaseSchemaMutation,
  publishSqliteDatabaseAdmission,
  readSqliteDatabaseWriteRevision,
  readSqliteDatabaseScopedWriteToken,
  revokeSqliteDatabaseAdmissions,
} from "./sqlite-database-admission.js";
import { runSqliteSchemaReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import { schemaAdmission } from "./sqlite-schema-admission.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  getSqliteReadOperationRevision,
  installSqliteTempTrackingSchema,
  registerSqliteSchemaMutationListener,
  runSqliteReadOperationSync,
} from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

describe("native SQLite schema snapshots and callbacks", () => {
  const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();

  it.each(["autocommit", "commit", "rollback", "callback failure"] as const)(
    "settles %s writes while an unrelated read cursor remains open",
    (outcome) => {
      const filename = path.join(tempDirs.make("sqlite-settled-writer-"), "agent.sqlite");
      const writer = openDatabase(
        "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES (1),(2)",
        true,
        filename,
      );
      const sibling = openDatabase("", true, filename);
      const before = readSqliteDatabaseScopedWriteToken(sibling, "session");
      expect(before).toBeTypeOf("string");
      const rows = writer.prepare("SELECT id FROM original").iterate();
      try {
        expect(rows.next().done).toBe(false);
        if (outcome === "callback failure") {
          expect(() =>
            runSqliteImmediateTransactionSync(writer, () => {
              writer.exec("INSERT INTO original VALUES (3)");
              expect(readSqliteDatabaseScopedWriteToken(sibling, "session")).toBeUndefined();
              throw new Error("synthetic transaction conflict");
            }),
          ).toThrow("synthetic transaction conflict");
        } else {
          if (outcome !== "autocommit") {
            writer.exec("BEGIN IMMEDIATE");
          }
          writer.exec("INSERT INTO original VALUES (3)");
          if (outcome !== "autocommit") {
            expect(readSqliteDatabaseScopedWriteToken(sibling, "session")).toBeUndefined();
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
        const settled = readSqliteDatabaseScopedWriteToken(sibling, "session");
        expect(settled).toBeTypeOf("string");
        expect(settled).not.toBe(before);
      } finally {
        rows.return?.();
      }
    },
  );

  it("fences a RETURNING writer until its own cursor settles", () => {
    const filename = path.join(tempDirs.make("sqlite-returning-writer-"), "agent.sqlite");
    const writer = openDatabase(
      "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES (1),(2)",
      true,
      filename,
    );
    const sibling = openDatabase("", true, filename);
    const reader = writer.prepare("SELECT id FROM original").iterate();
    const write = writer.prepare("INSERT INTO original VALUES (3),(4) RETURNING id").iterate();
    try {
      expect(reader.next().done).toBe(false);
      expect(write.next().value).toEqual({ id: 3 });
      expect(readSqliteDatabaseScopedWriteToken(sibling, "session")).toBeUndefined();
      writer.prepare("SELECT 1").get();
      expect(readSqliteDatabaseScopedWriteToken(sibling, "session")).toBeUndefined();
      expect(() => sibling.exec("BEGIN IMMEDIATE")).toThrow(/locked/iu);
      write.return?.();
      sibling.exec("BEGIN IMMEDIATE; ROLLBACK");
      expect(readSqliteDatabaseScopedWriteToken(sibling, "session")).toBeTypeOf("string");
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
    const cursor = createSqliteDatabaseAdmissionCursor();
    const before = captureSqliteDatabaseAdmissions(cursor);
    const firstSnapshot = before.find((record) => record.location === first.location())!;
    const secondSnapshot = before.find((record) => record.location === second.location())!;
    const key = { name: "publication-value", read: (value: unknown) => value };

    installSqliteDatabaseAdmissions(before);
    expect(captureSqliteDatabaseAdmissions(cursor)).toEqual([]);
    expect(
      captureSqliteDatabaseAdmissions().find(
        (record) => record.identity === firstSnapshot.identity,
      ),
    ).toBe(firstSnapshot);

    publishSqliteDatabaseAdmission(second, key, 42);
    const changed = captureSqliteDatabaseAdmissions(cursor);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.identity).toBe(secondSnapshot.identity);
    expect(changed[0]!.facts.get(key.name)?.value).toBe(42);
    expect(secondSnapshot.facts.has(key.name)).toBe(false);
    expect(
      captureSqliteDatabaseAdmissions().find(
        (record) => record.identity === firstSnapshot.identity,
      ),
    ).toBe(firstSnapshot);
    expect(captureSqliteDatabaseAdmissions(cursor)).toEqual([]);

    revokeSqliteDatabaseAdmissions(second);
    installSqliteDatabaseAdmissions(changed);
    expect(getSqliteDatabaseAdmission(second, key)).toBeUndefined();
    expect(captureSqliteDatabaseAdmissions(cursor)).toEqual([]);
    const secondLocation = second.location()!;
    second.close();
    retireSqliteDatabaseAdmissionForPath(secondLocation);
    expect(
      captureSqliteDatabaseAdmissions().some(
        (record) => record.identity === secondSnapshot.identity,
      ),
    ).toBe(false);
  });

  it.each(["scoped", "full"] as const)(
    "keeps other database publications pending for the next %s capture",
    (nextCapture) => {
      const cursor = createSqliteDatabaseAdmissionCursor();
      // Other cases retain process-wide admissions; acknowledge those before creating this pair.
      captureSqliteDatabaseAdmissions(cursor);
      const root = tempDirs.make("openclaw-admission-scoped-cursor-");
      const first = path.join(root, "first.sqlite");
      const second = path.join(root, "second.sqlite");
      openDatabase(undefined, true, first);
      openDatabase(undefined, true, second);

      expect(
        captureSqliteDatabaseAdmissions(cursor, { location: first }).map(
          (record) => record.location,
        ),
      ).toEqual([first]);
      expect(
        captureSqliteDatabaseAdmissions(
          cursor,
          nextCapture === "scoped" ? { location: second } : undefined,
        ).map((record) => record.location),
      ).toEqual([second]);
      expect(captureSqliteDatabaseAdmissions(cursor)).toEqual([]);
    },
  );

  it.each([
    "CREATE TEMP TABLE other_input (id)",
    "DROP TABLE temp.memory_publication_input",
    'DROP TABLE IF EXISTS "TeMp"."memory_publication_input"',
    "DROP /* cleanup */ TABLE `temp`.[memory_publication_input]; -- done",
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
      kind: "transcript-index",
      statusTable: "local_status",
      pendingTable: "local_pending",
      pendingIndex: "local_pending_state",
      observedTables: [],
    });
    const schema = getAdmittedSqliteSchemaFacts(database);
    const localRevision = () =>
      runSqliteReadOperationSync(database, () => getSqliteReadOperationRevision(database));
    const beforeLocal = localRevision();
    expect(beforeLocal).toBeDefined();
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(database, schemaMutation);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      database.exec(sql);
      expect(localRevision()).not.toBe(beforeLocal);
      expect(getAdmittedSqliteSchemaFacts(database)?.admissionId).toBe(schema?.admissionId);
      const sibling = openDatabase("", true, filename);
      expect(getAdmittedSqliteSchemaFacts(sibling)?.admissionId).toBe(schema?.admissionId);
      expect(schemaMutation).not.toHaveBeenCalled();
      expect(observation.queries).toEqual([]);
      const beforeWrite = readSqliteDatabaseWriteRevision(sibling);
      database.exec("UPDATE temp.local_status SET sibling_write_revision=1");
      expect(readSqliteDatabaseWriteRevision(sibling)).not.toBe(beforeWrite);
    } finally {
      observation.restore();
    }
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
    expect(captureSqliteDatabaseAdmissions().some((record) => record.location === filename)).toBe(
      false,
    );
    admitSqliteSchema(database);
    const record = captureSqliteDatabaseAdmissions().find((entry) => entry.location === filename)!;
    expect(fstatSync(record.descriptor).isFile()).toBe(true);
    const staleTransfer = structuredClone([record]);
    database.close();
    retireSqliteDatabaseAdmissionForPath(filename);
    expect(() => fstatSync(record.descriptor)).toThrow();
    installSqliteDatabaseAdmissions(staleTransfer);
    expect(
      captureSqliteDatabaseAdmissions().some((entry) => entry.identity === record.identity),
    ).toBe(false);
  });

  it("does not retire canonical admission through a snapshot hardlink", () => {
    const root = tempDirs.make("openclaw-schema-hardlink-");
    const filename = path.join(root, "state.sqlite");
    const database = openDatabase(undefined, true, filename);
    const snapshot = path.join(root, "snapshot.sqlite");
    linkSync(filename, snapshot);
    const record = captureSqliteDatabaseAdmissions().find((entry) => entry.location === filename)!;
    retireSqliteDatabaseAdmissionForPath(snapshot);
    expect(fstatSync(record.descriptor).isFile()).toBe(true);
    expect(tableExists(database, "original")).toBe(true);
  });

  it("fences an unadmitted host writer before callbacks can admit siblings", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-cold-host-"), "state.sqlite");
    const setup = new DatabaseSync(filename);
    setup.exec("PRAGMA journal_mode=WAL; CREATE TABLE original(id)");
    setup.close();
    const writer = openDatabase("", false, filename);
    let sibling: DatabaseSync | undefined;
    const seen: string[][] = [];
    writer.function("inspect_catalog", () => {
      sibling ??= openDatabase("", true, filename);
      expect(hasPendingSqliteDatabaseSchemaMutation(sibling)).toBe(true);
      const visible = sibling
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name);
      const admitted = [...(getAdmittedSqliteSchemaFacts(sibling)?.tables ?? [])].toSorted();
      expect(admitted).toEqual(visible);
      seen.push(admitted);
      return 1;
    });
    writer.exec(
      "CREATE TABLE first(id); SELECT inspect_catalog(); CREATE TABLE second(id); SELECT inspect_catalog()",
    );
    expect(seen).toEqual([
      ["first", "original"],
      ["first", "original", "second"],
    ]);
  });

  it.for([false, true])(
    "discards raw savepoint row receipts without DDL: schemaDependent=%s",
    (schemaDependent) => {
      const filename = path.join(tempDirs.make("openclaw-schema-row-rollback-"), "state.sqlite");
      const database = openDatabase(
        "CREATE TABLE original(id); INSERT INTO original VALUES(1)",
        true,
        filename,
      );
      const sibling = openDatabase("", true, filename);
      const key = {
        name: "row-backed-admission",
        schemaDependent,
        read: (value: unknown) => (typeof value === "number" ? value : undefined),
      };
      publishSqliteDatabaseAdmission(database, key, 1);
      runSqliteImmediateTransactionSync(database, () => {
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
      runSqliteImmediateTransactionSync(database, () => {
        publishSqliteDatabaseAdmission(database, key, 2);
        expect(getSqliteDatabaseAdmission(database, key)).toBe(2);
      });
      expect(getSqliteDatabaseAdmission(sibling, key)).toBe(2);
    },
  );

  it("revokes catalog and schema-dependent receipts rolled back by raw savepoints", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-savepoint-"), "state.sqlite");
    const database = openDatabase("CREATE TABLE original(id)", true, filename);
    const sibling = openDatabase("", true, filename);
    const key = {
      name: "savepoint-table-ready",
      schemaDependent: true,
      read: (value: unknown) => (value === true ? true : undefined),
    };
    runSqliteImmediateTransactionSync(database, () => {
      database.exec("SAVEPOINT s");
      database.exec("CREATE TABLE rolled_back(id)");
      expect(getAdmittedSqliteSchemaFacts(database)?.tables.has("rolled_back")).toBe(true);
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
    "BEGIN; SELECT * FROM original",
    "SAVEPOINT s; SELECT * FROM original",
    "BEGIN; SELECT * FROM original; SELECT * FROM missing",
  ])("qualifies the historical snapshot left by a raw control batch: %s", (sql) => {
    const filename = path.join(tempDirs.make("openclaw-schema-control-batch-"), "state.sqlite");
    const reader = openDatabase(
      "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES(1); PRAGMA user_version=1",
      true,
      filename,
    );
    const writer = openDatabase("", true, filename);
    if (sql.includes("missing")) {
      expect(() => reader.exec(sql)).toThrow("no such table");
    } else {
      reader.exec(sql);
    }
    expect(reader.isTransaction).toBe(true);
    writer.exec("CREATE TABLE committed_sibling(id); PRAGMA user_version=2");
    const committed = getAdmittedSqliteSchemaFacts(writer);
    expect(getAdmittedSqliteSchemaFacts(reader)?.userVersion).toBe(1);
    expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(tableExists(reader, "committed_sibling")).toBe(false);
    reader.exec("COMMIT");
    expect(getAdmittedSqliteSchemaFacts(reader)?.admissionId).toBe(committed?.admissionId);
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
    { sql: "SELECT id FROM original", finish: "get", version: 1 },
    { sql: "SELECT id FROM original", finish: "all", version: 1 },
    { sql: "SELECT id FROM original", finish: "run", version: 1 },
    { sql: "SELECT id FROM original", finish: "close", version: 1 },
    { sql: "SELECT id FROM original", finish: "dispose", version: 1 },
    { sql: "SELECT id FROM original", finish: "bad bindings", version: 1 },
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
      const filename = path.join(tempDirs.make("openclaw-schema-iterator-"), "state.sqlite");
      const reader = openDatabase(
        "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES(1),(2); PRAGMA user_version=1",
        true,
        filename,
      );
      const writer = openDatabase("", true, filename);
      const statement = reader.prepare(sql);
      const rows = statement.iterate();
      try {
        expect(rows.next().done).toBe(false);
        writer.exec("CREATE TABLE committed_sibling(id); PRAGMA user_version=2");
        const committed = getAdmittedSqliteSchemaFacts(writer);
        const admission = observeSqliteReadSql(StatementSync.prototype);
        try {
          expect(getAdmittedSqliteSchemaFacts(reader)?.userVersion).toBe(version);
          expect(tableExists(reader, "committed_sibling")).toBe(version === 2);
          expect(admission.queries).toHaveLength(3);
        } finally {
          admission.restore();
        }
        expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
        const visible =
          reader.prepare("SELECT name FROM sqlite_schema WHERE name='committed_sibling'").get() !==
          undefined;
        expect(visible).toBe(version === 2);
        expect(getAdmittedSqliteSchemaFacts(writer)?.admissionId).toBe(committed?.admissionId);
        if (finish === "return") {
          rows.return?.();
        } else if (finish === "complete") {
          expect([...rows]).toHaveLength(1);
        } else if (finish === "database close") {
          reader.close();
          reader.open();
        } else if (finish === "dispose") {
          statement[Symbol.dispose]?.();
        } else if (finish === "bad bindings") {
          expect(() => statement.get({ unknown: 1 })).toThrow("Unknown named parameter 'unknown'");
        } else {
          statement[finish]?.();
        }
        const observation = observeSqliteReadSql(StatementSync.prototype);
        try {
          expect(getAdmittedSqliteSchemaFacts(reader)?.admissionId).toBe(committed?.admissionId);
          expect(observation.queries).toEqual([]);
        } finally {
          observation.restore();
        }
        reader.exec("CREATE TABLE after_reset(value)");
        expect(hasPendingSqliteDatabaseSchemaMutation(writer)).toBe(false);
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

  it.for(["get", "all", "run", "iterate"] as const)(
    "expires historical facts before callbacks from replacement %s execution",
    (method) => {
      const filename = path.join(
        tempDirs.make("openclaw-schema-replacement-callback-"),
        "state.sqlite",
      );
      const reader = openDatabase(
        "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES(1),(2); PRAGMA user_version=1",
        true,
        filename,
      );
      const writer = openDatabase("", true, filename);
      let inspect = false;
      const observed: Array<{ cached: number | undefined; native: unknown; table: boolean }> = [];
      reader.function("read_catalog", () => {
        if (inspect) {
          observed.push({
            cached: getAdmittedSqliteSchemaFacts(reader)?.userVersion,
            native: reader.prepare("PRAGMA user_version").get()?.user_version,
            table: tableExists(reader, "added"),
          });
        }
        return 1;
      });
      const statement = reader.prepare("SELECT id, read_catalog() FROM original");
      const old = statement.iterate();
      try {
        old.next();
        writer.exec("CREATE TABLE added(id); PRAGMA user_version=2");
        expect(getAdmittedSqliteSchemaFacts(reader)?.userVersion).toBe(1);
        inspect = true;
        if (method === "iterate") {
          const replacement = statement.iterate();
          try {
            replacement.next();
          } finally {
            replacement.return?.();
          }
        } else {
          statement[method]();
        }
        expect(observed.length).toBeGreaterThan(0);
        expect(
          observed.every((value) => value.cached === 2 && value.native === 2 && value.table),
        ).toBe(true);
      } finally {
        old.return?.();
      }
    },
  );

  it.for(["iterate", "get", "all", "run", "exec"] as const)(
    "keeps callback captures inside the native %s snapshot",
    (method) => {
      const filename = path.join(tempDirs.make("openclaw-schema-first-callback-"), "state.sqlite");
      const reader = openDatabase(
        "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES(1); PRAGMA user_version=1",
        true,
        filename,
      );
      const writer = openDatabase("", true, filename);
      reader.function("read_catalog", () => {
        writer.exec("CREATE TABLE added(id); PRAGMA user_version=2");
        expect(getAdmittedSqliteSchemaFacts(reader)?.userVersion).toBe(1);
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
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        expect(getAdmittedSqliteSchemaFacts(reader)?.userVersion).toBe(2);
        expect(getAdmittedSqliteSchemaFacts(writer)?.userVersion).toBe(2);
        expect(observation.queries).toEqual([]);
      } finally {
        observation.restore();
      }
    },
  );

  it("observes completed DDL iterator replay according to the native runtime", () => {
    const native = new DatabaseSync(":memory:");
    let expected: boolean;
    try {
      const control = native.prepare("DROP TABLE IF EXISTS target").iterate();
      control.next();
      native.exec("CREATE TABLE target(id)");
      control.next();
      expected =
        native.prepare("SELECT name FROM sqlite_schema WHERE name='target'").get() !== undefined;
      control.return?.();
    } finally {
      native.close();
    }
    const filename = path.join(tempDirs.make("openclaw-schema-done-ddl-"), "state.sqlite");
    const writer = openDatabase(undefined, true, filename);
    const reader = openDatabase("", true, filename);
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
      expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(false);
    } finally {
      rows.return?.();
    }
  });

  it.for(["completion", "return"] as const)(
    "preserves native return after %s without losing newer cursor custody",
    (ending) => {
      const schema = "CREATE TABLE original(id); INSERT INTO original VALUES(1),(2)";
      const native = new DatabaseSync(":memory:");
      let expected: unknown;
      try {
        native.exec(schema);
        const statement = native.prepare("SELECT id FROM original");
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
        expected = current.next().value?.id;
        current.return?.();
      } finally {
        native.close();
      }
      const filename = path.join(tempDirs.make("openclaw-schema-return-done-"), "state.sqlite");
      const writer = openDatabase(`PRAGMA journal_mode=WAL; ${schema}`, true, filename);
      const reader = openDatabase("", true, filename);
      const statement = writer.prepare("SELECT id FROM original");
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
      try {
        if (expected === 1) {
          writer.exec("CREATE TABLE after_return(id)");
          expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(true);
          expect(tableExists(reader, "after_return")).toBe(true);
        }
        expect(current.next().value?.id).toBe(expected);
      } finally {
        current.return?.();
      }
      expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(false);
    },
  );

  it("binds iterators eagerly while retaining native prototype and result semantics", () => {
    const database = openDatabase();
    const native = new DatabaseSync(":memory:");
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
      native.close();
    }
  });

  it("resets eagerly without retaining custody for unstepped iterators", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-unstepped-"), "state.sqlite");
    const reader = openDatabase(
      "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES(1),(2); PRAGMA user_version=1",
      true,
      filename,
    );
    const sibling = openDatabase("", true, filename);
    const statement = reader.prepare("SELECT id FROM original");
    const old = statement.iterate();
    old.next();
    const current = statement.iterate();
    try {
      expect(() => old.next()).toThrow(/invalidated/iu);
      reader.exec("CREATE TABLE while_unstepped(id)");
      expect(hasPendingSqliteDatabaseSchemaMutation(sibling)).toBe(false);
      expect(tableExists(sibling, "while_unstepped")).toBe(true);
      expect(current.next().value).toEqual({ id: 1 });
      // Native return on the old iterator resets the statement without invalidating
      // the newer iterator's generation; its next step can start the query again.
      old.return?.();
      reader.exec("CREATE TABLE after_old_return(id)");
      expect(hasPendingSqliteDatabaseSchemaMutation(sibling)).toBe(true);
      expect(tableExists(sibling, "after_old_return")).toBe(true);
      expect(current.next().value).toEqual({ id: 1 });
    } finally {
      current.return?.();
      old.return?.();
    }
    expect(hasPendingSqliteDatabaseSchemaMutation(sibling)).toBe(false);
  });

  it.skipIf(typeof StatementSync.prototype.close !== "function")(
    "preserves an iterator when native statement reuse is refused before reset",
    () => {
      const filename = path.join(tempDirs.make("openclaw-schema-reentrant-"), "state.sqlite");
      const reader = openDatabase(
        "PRAGMA journal_mode=WAL; CREATE TABLE original(id); INSERT INTO original VALUES(1),(2); PRAGMA user_version=1",
        true,
        filename,
      );
      const writer = openDatabase("", true, filename);
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
      const raw = new DatabaseSync(filename);
      try {
        expect(raw.prepare("SELECT agent_id FROM schema_meta").get()?.agent_id).toBe("original");
        const replaced = openDatabase(schema("replacement"), true, replacement);
        expect(readExistingAgentSchemaMeta(replaced)?.agentId).toBe("replacement");
        renameSync(replacement, filename);
        expect(readExistingAgentSchemaMeta(raw)?.agentId).toBe("original");
        expect(readExistingAgentSchemaMeta(replaced)?.agentId).toBe("replacement");
        const denied = new DatabaseSync(filename);
        try {
          denied.setAuthorizer((action, table) =>
            action === constants.SQLITE_READ && table === "schema_meta"
              ? constants.SQLITE_DENY
              : constants.SQLITE_OK,
          );
          expect(() => readExistingAgentSchemaMeta(denied)).toThrow(/prohibited|authorized/iu);
        } finally {
          denied.close();
        }
      } finally {
        raw.close();
      }
    },
  );

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "tracks DDL custody and shared catalog changes while an authorizer is installed",
    () => {
      const filename = path.join(tempDirs.make("openclaw-schema-authorized-ddl-"), "state.sqlite");
      const writer = openDatabase(undefined, true, filename);
      const sibling = openDatabase("", true, filename);
      const revision = getSqliteDatabaseSchemaRevision(sibling)!;
      let observed = false;
      writer.function("observe_pending", () => {
        observed = true;
        expect(hasPendingSqliteDatabaseSchemaMutation(sibling)).toBe(true);
        expect(getAdmittedSqliteSchemaFacts(sibling)?.tables.has("authorized_table")).toBe(true);
        return 1;
      });
      writer.setAuthorizer(() => constants.SQLITE_OK);
      writer.exec("CREATE TABLE authorized_table(value); SELECT observe_pending()");
      expect(observed).toBe(true);
      expect(getSqliteDatabaseSchemaRevision(sibling)).toBeGreaterThan(revision);
      writer.setAuthorizer(null);
      expect(getAdmittedSqliteSchemaFacts(writer)?.tables.has("authorized_table")).toBe(true);
      expect(getAdmittedSqliteSchemaFacts(sibling)?.tables.has("authorized_table")).toBe(true);
      writer.setAuthorizer((action) =>
        action === constants.SQLITE_CREATE_TABLE ? constants.SQLITE_DENY : constants.SQLITE_OK,
      );
      expect(() => writer.exec("CREATE TABLE denied_table(value)")).toThrow(/authorized/iu);
      writer.setAuthorizer(null);
      expect(hasPendingSqliteDatabaseSchemaMutation(sibling)).toBe(false);
      expect(getAdmittedSqliteSchemaFacts(sibling)?.tables.has("denied_table")).toBe(false);
    },
  );

  it.each([
    { admitted: false, read: "SELECT id FROM original", version: 1 },
    { admitted: true, read: "SELECT id FROM original", version: 1 },
    { admitted: true, read: undefined, version: 2 },
    { admitted: true, read: "SELECT 1", version: 2 },
  ])(
    "binds native snapshots after read=$read, admitted=$admitted",
    ({ admitted, read, version }) => {
      const filename = path.join(tempDirs.make("openclaw-schema-raw-snapshot-"), "state.sqlite");
      const reader = openDatabase(undefined, admitted, filename);
      reader.exec("PRAGMA journal_mode=WAL");
      const writer = openDatabase("", true, filename);
      reader.exec("BEGIN");
      if (read) {
        reader.prepare(read).all();
      }
      writer.exec("CREATE TABLE committed_sibling (id); PRAGMA user_version=2");
      const committed = getAdmittedSqliteSchemaFacts(writer);
      admitSqliteSchema(reader);
      expect(getAdmittedSqliteSchemaFacts(reader)?.userVersion).toBe(version);
      expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
      expect(getAdmittedSqliteSchemaFacts(reader)?.tables.has("committed_sibling")).toBe(
        version === 2,
      );
      expect(getAdmittedSqliteSchemaFacts(writer)?.admissionId).toBe(committed?.admissionId);
      reader.exec("ROLLBACK");
      expect(getAdmittedSqliteSchemaFacts(reader)?.admissionId).toBe(committed?.admissionId);
    },
  );

  it("qualifies managed snapshots at their first native read", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-managed-snapshot-"), "state.sqlite");
    const reader = openDatabase(undefined, true, filename);
    reader.exec("PRAGMA journal_mode=WAL");
    const writer = openDatabase("", true, filename);
    reader.exec("BEGIN");
    runSqliteReadOperationSync(reader, () => {
      reader.prepare("SELECT id FROM original").all();
      writer.exec("CREATE TABLE committed_sibling (id); PRAGMA user_version=2");
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        expect(getAdmittedSqliteSchemaFacts(reader)?.userVersion).toBe(1);
        expect(getAdmittedSqliteSchemaFacts(reader)?.tables.has("committed_sibling")).toBe(false);
        expect(observation.queries).toEqual([]);
      } finally {
        observation.restore();
      }
      expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    });
    reader.exec("ROLLBACK");
    runSqliteSchemaReadSnapshotSync(reader, () => {
      expect(getAdmittedSqliteSchemaFacts(reader)?.userVersion).toBe(2);
      expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    }); // The pin marker exists before SQLite steps its first row.
    let changed = false;
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the original native receiver.
    const iterate = StatementSync.prototype.iterate;
    const race = vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(
      new Proxy(iterate, {
        apply(target, receiver: StatementSync, args) {
          if (!changed && receiver.sourceSQL === "PRAGMA schema_version") {
            changed = true;
            writer.exec("CREATE TABLE raced_sibling (id); PRAGMA user_version=3");
          }
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    try {
      runSqliteSchemaReadSnapshotSync(reader, () => {
        expect(changed).toBe(true);
        expect(getAdmittedSqliteSchemaFacts(reader)?.userVersion).toBe(3);
        expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
      });
    } finally {
      race.mockRestore();
    }
  });

  it.each(["exec", "get", "all", "iterate", "iterate-close", "aggregate"] as const)(
    "settles callback DDL and private admission facts through %s",
    (method) => {
      const filename = path.join(tempDirs.make("openclaw-schema-callback-"), "state.sqlite");
      const database = openDatabase(
        "CREATE TABLE input(value INTEGER CHECK(value<0))",
        true,
        filename,
      );
      const sibling = openDatabase("", true, filename);
      const key = {
        name: "callback-fact",
        schemaDependent: true,
        read: (value: unknown) => (value === true ? true : undefined),
      };
      const callback = () => {
        database.exec("CREATE TABLE callback_table(value)");
        expect(getAdmittedSqliteSchemaFacts(database)?.tables.has("callback_table")).toBe(true);
        publishSqliteDatabaseAdmission(database, key, true);
        expect(getSqliteDatabaseAdmission(database, key)).toBe(true);
        expect(getSqliteDatabaseAdmission(sibling, key)).toBeUndefined();
        const visible =
          sibling.prepare("SELECT name FROM sqlite_schema WHERE name='callback_table'").get() !==
          undefined;
        expect(getAdmittedSqliteSchemaFacts(sibling)?.tables.has("callback_table")).toBe(visible);
        return 1;
      };
      database.function("side_effect", callback);
      if (method === "aggregate") {
        database.aggregate("aggregate_effect", { start: 0, step: (_sum, _value) => callback() });
        database.prepare("SELECT aggregate_effect(column1) FROM (VALUES(1))").get();
      } else if (method === "exec") {
        expect(() => database.exec("INSERT INTO input VALUES(side_effect())")).toThrow(
          /CHECK constraint/iu,
        );
      } else {
        const statement = database.prepare("SELECT side_effect()");
        if (method === "iterate-close") {
          const rows = statement.iterate();
          expect(rows.next().done).toBe(false);
          database.close();
          database.open();
          expect(() => rows.next()).toThrow(/invalidated|finalized/iu);
          expect(() => rows.return?.()).toThrow(/finalized/iu);
        } else if (method === "iterate") {
          expect([...statement.iterate()]).toHaveLength(1);
        } else {
          statement[method]();
        }
      }
      const actual =
        database.prepare("SELECT name FROM sqlite_schema WHERE name='callback_table'").get() !==
        undefined;
      expect(actual).toBe(method !== "exec");
      expect(getAdmittedSqliteSchemaFacts(database)?.tables.has("callback_table")).toBe(actual);
      expect(getAdmittedSqliteSchemaFacts(sibling)?.tables.has("callback_table")).toBe(actual);
      expect(getSqliteDatabaseAdmission(sibling, key)).toBeUndefined();
    },
  );
});
