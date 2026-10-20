import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import {
  readSqliteDatabasePendingScopedWriteToken,
  readSqliteDatabaseScopedWriteToken,
  withSqliteDatabaseWriteScope,
} from "../sqlite-database-admission.js";
import { PostgresSyncConnection } from "./connection.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("PostgreSQL exclusive idle connection reuse", () => {
  const admin = new Client({ connectionString: connection });
  const schema = `reuse_${randomUUID().replaceAll("-", "")}`;
  const anchor = new DatabaseSync(":memory:");
  const opened: PostgresSyncConnection[] = [];
  const run = withEngineStoreAdmission;
  function open(dsn = connection!, namespace = schema) {
    const db = run(
      () => new PostgresSyncConnection(dsn, namespace, anchor, schema, { reuse: true }),
    );
    opened.push(db);
    return db;
  }
  const pid = (db: PostgresSyncConnection) =>
    run(() => db.prepare("SELECT pg_backend_pid() AS pid").get()!.pid);
  const exec = (db: PostgresSyncConnection, sql: string) => run(() => db.exec(sql));
  const rows = (db: PostgresSyncConnection, sql: string) => run(() => db.prepare(sql).all());
  const get = (db: PostgresSyncConnection, sql: string) => run(() => db.prepare(sql).get());
  const close = (db: PostgresSyncConnection) => run(() => db.close());
  const token = readSqliteDatabaseScopedWriteToken;
  const pendingToken = readSqliteDatabasePendingScopedWriteToken;
  const transaction = (db: PostgresSyncConnection, body: () => void, readOnly = false) =>
    run(() => db.runTransaction(body, undefined, readOnly));
  const scoped = (db: PostgresSyncConnection, scope: string, body: () => void) =>
    transaction(db, () => withSqliteDatabaseWriteScope(db, [scope], body));

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".entries (id integer)`);
  });
  afterAll(async () => {
    for (const db of opened) {
      close(db);
    }
    anchor.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("reuses an idle backend, but overlapping transactions have exclusive connections", () => {
    const first = open();
    const firstPid = pid(first);
    close(first);
    expect(first.isOpen).toBe(false);
    expect(() => exec(first, "SELECT 1")).toThrow("closed");
    const writer = open();
    expect(pid(writer)).toBe(firstPid);
    exec(writer, "BEGIN; INSERT INTO entries VALUES (1)");
    const reader = open();
    expect(pid(reader)).not.toBe(firstPid);
    expect(get(reader, "SELECT count(*)::int AS count FROM entries")).toEqual({ count: 0 });
    // Closing a live transaction must roll it back and discard that backend.
    close(writer);
    expect(get(reader, "SELECT count(*)::int AS count FROM entries")).toEqual({ count: 0 });
    close(reader);
  });

  it("retains unrelated replicas and predicts only the written scope across commits", () => {
    const db = open();
    exec(db, "CREATE TABLE scoped_entries (id integer)");
    const before = token(db, "first");
    const second = token(db, "second");
    let pending: string | undefined;
    scoped(db, "second", () => {
      db.prepare("INSERT INTO scoped_entries VALUES (?)").run(7);
      pending = pendingToken(db, "second");
      expect(pendingToken(db, "first")).toBe(before);
      // Closing another handle to this anchor cannot settle the writer's pending receipt.
      const reader = open();
      reader.close();
      expect(token(db, "second")).toBe(second);
    });
    expect(pending).not.toBe(second);
    expect(token(db, "second")).toBe(pending);
    expect(token(db, "first")).toBe(before);

    run(() => db.runTransaction(() => db.prepare("SELECT count(*) FROM scoped_entries").get()));
    run(() => db.runTransaction(() => {}));
    expect(token(db, "first")).toBe(before);
    expect(token(db, "second")).toBe(pending);

    // Uncertified writes still invalidate both scopes.
    run(() => db.runTransaction(() => db.exec("INSERT INTO scoped_entries VALUES (8); SELECT 1")));
    expect(token(db, "first")).not.toBe(before);
    expect(token(db, "second")).not.toBe(pending);
    const beforeCte = token(db, "first");
    transaction(db, () =>
      db.exec(
        "WITH changed AS (UPDATE scoped_entries SET id = id + 1 RETURNING *) SELECT * FROM changed",
      ),
    );
    expect(token(db, "first")).not.toBe(beforeCte);
    exec(db, "DROP TABLE scoped_entries");
    close(db);
  });

  it("keeps read snapshots pure when columns use qualified SQL keywords", () => {
    const db = open();
    exec(db, 'CREATE TABLE keyword_entries ("update" integer, "into" integer)');
    exec(db, "INSERT INTO keyword_entries VALUES (7, 8)");
    const before = token(db, "first");
    transaction(
      db,
      () => {
        expect(
          db.query("SELECT t.update, t . /* column */ into FROM keyword_entries AS t").rows,
        ).toEqual([{ update: 7, into: 8 }]);
      },
      true,
    );
    expect(token(db, "first")).toBe(before);
    exec(db, "DROP TABLE keyword_entries");
    close(db);
  });

  it("rejects mutation hints in read snapshots without settling a sibling writer", () => {
    const writer = open();
    const reader = open();
    exec(writer, "CREATE TABLE snapshot_entries (merge integer)");
    const before = token(writer, "entry");
    let pending: string | undefined;
    scoped(writer, "entry", () => {
      writer.prepare("INSERT INTO snapshot_entries VALUES (?)").run(7);
      pending = pendingToken(writer, "entry");
      expect(pending).not.toBe(before);
      expect(() =>
        reader.runTransaction(
          () => reader.query("SELECT merge FROM snapshot_entries"),
          undefined,
          true,
        ),
      ).toThrow("PostgreSQL read snapshot cannot execute a mutation");
      expect(token(writer, "entry")).toBe(before);
      expect(pendingToken(writer, "entry")).toBe(pending);
    });
    expect(token(writer, "entry")).toBe(pending);
    expect(run(() => reader.query("SELECT * FROM snapshot_entries").rows)).toEqual([{ merge: 7 }]);
    exec(writer, "DROP TABLE snapshot_entries");
    close(reader);
    close(writer);
  });

  it("preserves certified CTE write scopes but fences SELECT INTO across scopes", () => {
    const db = open();
    exec(db, "CREATE TABLE cte_entries (id integer)");
    const first = token(db, "first");
    const second = token(db, "second");
    let pending: string | undefined;
    scoped(db, "second", () => {
      expect(
        db.query(
          "WITH inserted AS (INSERT INTO cte_entries VALUES (7) RETURNING id) SELECT id FROM inserted",
        ).rows,
      ).toEqual([{ id: 7 }]);
      pending = pendingToken(db, "second");
    });
    expect(token(db, "first")).toBe(first);
    expect(token(db, "second")).toBe(pending);
    expect(pending).not.toBe(second);

    scoped(db, "second", () =>
      db.exec('SELECT source."id" INTO cte_copy FROM cte_entries AS source'),
    );
    expect(token(db, "first")).not.toBe(first);
    const afterQuoted = token(db, "first");
    scoped(db, "second", () => db.exec("SELECT 1. INTO cte_number"));
    expect(token(db, "first")).not.toBe(afterQuoted);
    exec(db, "DROP TABLE cte_copy; DROP TABLE cte_number; DROP TABLE cte_entries");
    close(db);
  });

  it("reconnects after an idle backend is terminated, without reusing the broken backend", async () => {
    const first = open();
    const killedPid = pid(first);
    close(first);
    await admin.query("SELECT pg_terminate_backend($1)", [killedPid]);
    // The server's termination notification is ordered before this next command response.
    await admin.query("SELECT 1");
    const recovered = open();
    expect(pid(recovered)).not.toBe(killedPid);
    expect(get(recovered, "SELECT 7::int AS value")).toEqual({ value: 7 });
    close(recovered);
  });

  it("uses the server transaction status when a combined statement leaves a transaction open", () => {
    const first = open();
    const originalPid = pid(first);
    exec(first, "SELECT 1; BEGIN; INSERT INTO entries VALUES (2)");
    close(first);
    const second = open();
    expect(pid(second)).not.toBe(originalPid);
    expect(get(second, "SELECT count(*)::int AS count FROM entries")).toEqual({ count: 0 });
    close(second);
  });

  it("settles committed batches and retains transactions opened later in a batch", () => {
    const db = open();
    exec(db, "CREATE TABLE batch_entries (id integer)");
    const before = token(db, "first");
    exec(db, "BEGIN; INSERT INTO batch_entries VALUES (1); COMMIT");
    expect(db.isTransaction).toBe(false);
    const committed = token(db, "first");
    expect(committed).not.toBe(before);
    expect(rows(db, "SELECT id FROM batch_entries")).toEqual([{ id: 1 }]);

    exec(db, "SELECT 1; BEGIN; INSERT INTO batch_entries VALUES (2)");
    expect(db.isTransaction).toBe(true);
    expect(token(db, "first")).toBe(committed);
    close(db);
    const reader = open();
    expect(rows(reader, "SELECT id FROM batch_entries")).toEqual([{ id: 1 }]);
    exec(reader, "DROP TABLE batch_entries");
    close(reader);
  });

  it("does not reuse across connection settings or namespaces", () => {
    const first = open();
    const originalPid = pid(first);
    close(first);
    const differentNamespace = open(connection!, "public");
    expect(pid(differentNamespace)).not.toBe(originalPid);
    expect(get(differentNamespace, "SELECT current_schema() AS schema")).toEqual({
      schema: "public",
    });
    close(differentNamespace);
    const dsn = new URL(connection!);
    dsn.searchParams.set("application_name", "reuse-independent");
    const differentSettings = open(dsn.href);
    expect(pid(differentSettings)).not.toBe(originalPid);
    close(differentSettings);
  });

  it("applies all session settings with a quoted, comma-containing schema name", async () => {
    const namespace = `${schema}_"first,second`;
    const quoted = `"${namespace.replaceAll('"', '""')}"`;
    await admin.query(`CREATE SCHEMA ${quoted}`);
    const db = run(
      () =>
        new PostgresSyncConnection(connection!, namespace, anchor, schema, {
          lockTimeoutMs: 321,
          statementTimeoutMs: 654,
        }),
    );
    try {
      expect(
        run(
          () =>
            db.query(
              "SELECT current_setting('synchronous_commit') AS synchronous_commit, " +
                "current_setting('lock_timeout') AS lock_timeout, " +
                "current_setting('statement_timeout') AS statement_timeout, " +
                "current_setting('search_path') AS search_path, current_schema() AS schema",
            ).rows,
        ),
      ).toEqual([
        {
          synchronous_commit: "off",
          lock_timeout: "321ms",
          statement_timeout: "654ms",
          search_path: quoted,
          schema: namespace,
        },
      ]);
    } finally {
      close(db);
      await admin.query(`DROP SCHEMA ${quoted}`);
    }
  });
});
