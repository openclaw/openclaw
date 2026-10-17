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

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".entries (id integer)`);
  });
  afterAll(async () => {
    for (const db of opened) {
      run(() => db.close());
    }
    anchor.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("reuses an idle backend, but overlapping transactions have exclusive connections", () => {
    const first = open();
    const firstPid = pid(first);
    run(() => first.close());
    expect(first.isOpen).toBe(false);
    expect(() => run(() => first.exec("SELECT 1"))).toThrow("closed");
    const writer = open();
    expect(pid(writer)).toBe(firstPid);
    run(() => writer.exec("BEGIN; INSERT INTO entries VALUES (1)"));
    const reader = open();
    expect(pid(reader)).not.toBe(firstPid);
    expect(run(() => reader.prepare("SELECT count(*)::int AS count FROM entries").get())).toEqual({
      count: 0,
    });
    // Closing a live transaction must roll it back and discard that backend.
    run(() => writer.close());
    expect(run(() => reader.prepare("SELECT count(*)::int AS count FROM entries").get())).toEqual({
      count: 0,
    });
    run(() => reader.close());
  });

  it("retains unrelated replicas and predicts only the written scope across commits", () => {
    const db = open();
    run(() => db.exec("CREATE TABLE scoped_entries (id integer)"));
    const before = readSqliteDatabaseScopedWriteToken(db, "first");
    const second = readSqliteDatabaseScopedWriteToken(db, "second");
    let pending: string | undefined;
    run(() =>
      db.runTransaction(() =>
        withSqliteDatabaseWriteScope(db, ["second"], () => {
          db.prepare("INSERT INTO scoped_entries VALUES (?)").run(7);
          pending = readSqliteDatabasePendingScopedWriteToken(db, "second");
          expect(readSqliteDatabasePendingScopedWriteToken(db, "first")).toBe(before);
          // Closing another handle to this anchor cannot settle the writer's pending receipt.
          const reader = open();
          reader.close();
          expect(readSqliteDatabaseScopedWriteToken(db, "second")).toBe(second);
        }),
      ),
    );
    expect(pending).not.toBe(second);
    expect(readSqliteDatabaseScopedWriteToken(db, "second")).toBe(pending);
    expect(readSqliteDatabaseScopedWriteToken(db, "first")).toBe(before);

    run(() => db.runTransaction(() => db.prepare("SELECT count(*) FROM scoped_entries").get()));
    run(() => db.runTransaction(() => {}));
    expect(readSqliteDatabaseScopedWriteToken(db, "first")).toBe(before);
    expect(readSqliteDatabaseScopedWriteToken(db, "second")).toBe(pending);

    // Uncertified writes still invalidate both scopes.
    run(() => db.runTransaction(() => db.exec("INSERT INTO scoped_entries VALUES (8); SELECT 1")));
    expect(readSqliteDatabaseScopedWriteToken(db, "first")).not.toBe(before);
    expect(readSqliteDatabaseScopedWriteToken(db, "second")).not.toBe(pending);
    const beforeCte = readSqliteDatabaseScopedWriteToken(db, "first");
    run(() =>
      db.runTransaction(() =>
        db.exec(
          "WITH changed AS (UPDATE scoped_entries SET id = id + 1 RETURNING *) SELECT * FROM changed",
        ),
      ),
    );
    expect(readSqliteDatabaseScopedWriteToken(db, "first")).not.toBe(beforeCte);
    run(() => db.exec("DROP TABLE scoped_entries"));
    run(() => db.close());
  });

  it("preserves certified CTE write scopes but fences SELECT INTO across scopes", () => {
    const db = open();
    run(() => db.exec("CREATE TABLE cte_entries (id integer)"));
    const first = readSqliteDatabaseScopedWriteToken(db, "first");
    const second = readSqliteDatabaseScopedWriteToken(db, "second");
    let pending: string | undefined;
    run(() =>
      db.runTransaction(() =>
        withSqliteDatabaseWriteScope(db, ["second"], () => {
          expect(
            db.query(
              "WITH inserted AS (INSERT INTO cte_entries VALUES (7) RETURNING id) SELECT id FROM inserted",
            ).rows,
          ).toEqual([{ id: 7 }]);
          pending = readSqliteDatabasePendingScopedWriteToken(db, "second");
        }),
      ),
    );
    expect(readSqliteDatabaseScopedWriteToken(db, "first")).toBe(first);
    expect(readSqliteDatabaseScopedWriteToken(db, "second")).toBe(pending);
    expect(pending).not.toBe(second);

    run(() =>
      db.runTransaction(() =>
        withSqliteDatabaseWriteScope(db, ["second"], () =>
          db.exec("SELECT id INTO cte_copy FROM cte_entries"),
        ),
      ),
    );
    expect(readSqliteDatabaseScopedWriteToken(db, "first")).not.toBe(first);
    run(() => db.exec("DROP TABLE cte_copy; DROP TABLE cte_entries"));
    run(() => db.close());
  });

  it("reconnects after an idle backend is terminated, without reusing the broken backend", async () => {
    const first = open();
    const killedPid = pid(first);
    run(() => first.close());
    await admin.query("SELECT pg_terminate_backend($1)", [killedPid]);
    // The server's termination notification is ordered before this next command response.
    await admin.query("SELECT 1");
    const recovered = open();
    expect(pid(recovered)).not.toBe(killedPid);
    expect(run(() => recovered.prepare("SELECT 7::int AS value").get())).toEqual({ value: 7 });
    run(() => recovered.close());
  });

  it("uses the server transaction status when a combined statement leaves a transaction open", () => {
    const first = open();
    const originalPid = pid(first);
    run(() => first.exec("SELECT 1; BEGIN; INSERT INTO entries VALUES (2)"));
    run(() => first.close());
    const second = open();
    expect(pid(second)).not.toBe(originalPid);
    expect(run(() => second.prepare("SELECT count(*)::int AS count FROM entries").get())).toEqual({
      count: 0,
    });
    run(() => second.close());
  });

  it("does not reuse across connection settings or namespaces", () => {
    const first = open();
    const originalPid = pid(first);
    run(() => first.close());
    const differentNamespace = open(connection!, "public");
    expect(pid(differentNamespace)).not.toBe(originalPid);
    expect(
      run(() => differentNamespace.prepare("SELECT current_schema() AS schema").get()),
    ).toEqual({
      schema: "public",
    });
    run(() => differentNamespace.close());
    const dsn = new URL(connection!);
    dsn.searchParams.set("application_name", "reuse-independent");
    const differentSettings = open(dsn.href);
    expect(pid(differentSettings)).not.toBe(originalPid);
    run(() => differentSettings.close());
  });
});
