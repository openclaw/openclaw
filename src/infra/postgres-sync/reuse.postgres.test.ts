import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import {
  readSqliteDatabasePendingScopedWriteToken as pendingToken,
  readSqliteDatabaseScopedWriteToken as token,
  withSqliteDatabaseWriteScope,
} from "../sqlite-database-admission.js";
import { PostgresSyncConnection } from "./connection.js";
import { usePostgresTestHarness } from "./postgres.test-support.js";

const harness = usePostgresTestHarness("reuse");
const { connection, prefix: schema, client: admin } = harness;

describe.skipIf(!connection)("PostgreSQL exclusive idle connection reuse", () => {
  const anchor = new DatabaseSync(":memory:");
  const opened: PostgresSyncConnection[] = [];
  const run = withEngineStoreAdmission;
  function open(
    dsn = connection!,
    namespace = schema,
    options: ConstructorParameters<typeof PostgresSyncConnection>[4] = { reuse: true },
  ) {
    const db = run(() => new PostgresSyncConnection(dsn, namespace, anchor, schema, options));
    opened.push(db);
    return db;
  }
  const pid = (db: PostgresSyncConnection) =>
    run(() => db.prepare("SELECT pg_backend_pid() AS pid").get()!.pid);
  const exec = (db: PostgresSyncConnection, sql: string) => run(() => db.exec(sql));
  const rows = (db: PostgresSyncConnection, sql: string) => run(() => db.prepare(sql).all());
  const get = (db: PostgresSyncConnection, sql: string) => run(() => db.prepare(sql).get());
  const query = (db: PostgresSyncConnection, sql: string) => run(() => db.query(sql).rows);
  const close = (db: PostgresSyncConnection) => run(() => db.close());
  const transaction = <T>(db: PostgresSyncConnection, body: () => T, readOnly = false) =>
    run(() => db.runTransaction(body, undefined, readOnly));
  const readOnly = (db: PostgresSyncConnection, sql: string) =>
    transaction(db, () => db.query(sql), true);
  const scoped = (db: PostgresSyncConnection, scope: string, body: () => void) =>
    transaction(db, () => withSqliteDatabaseWriteScope(db, [scope], body));
  const tokens = (db: PostgresSyncConnection) => [token(db, "first"), token(db, "second")];
  const backendRows = async (backendPid: unknown) =>
    (await admin.query("SELECT pid FROM pg_stat_activity WHERE pid = $1", [backendPid])).rows;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".entries (id integer)`);
  });
  afterEach(() => opened.splice(0).forEach(close));
  harness.onClose(() => anchor.close());

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
  });

  it("expires quiet backends while preserving burst reuse and checked-out connections", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = open();
      const firstPid = pid(first);
      close(first);
      vi.advanceTimersByTime(2 * 60_000);
      const borrowed = open();
      expect(pid(borrowed)).toBe(firstPid);
      // Its previous idle deadline must not retire a checked-out connection.
      vi.advanceTimersByTime(2 * 60_000);
      expect(get(borrowed, "SELECT 7::int AS value")).toEqual({ value: 7 });
      close(borrowed);
      vi.advanceTimersByTime(3 * 60_000);
      // Pool expiry ends the client asynchronously after closing its port.
      await expect.poll(() => backendRows(firstPid), { timeout: 10_000, interval: 50 }).toEqual([]);
      const reopened = open();
      expect(pid(reopened)).not.toBe(firstPid);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["plain", "cte"] as const)("settles only certified %s write scopes", (kind) => {
    const db = open();
    const table = `scoped_${kind}`;
    exec(db, `CREATE TABLE ${table} (id integer)`);
    const [before, second] = tokens(db);
    let pending: string | undefined;
    scoped(db, "second", () => {
      if (kind === "plain") {
        db.prepare(`INSERT INTO ${table} VALUES (?)`).run(7);
      } else {
        expect(
          db.query(
            `WITH inserted AS (INSERT INTO ${table} VALUES (7) RETURNING id) SELECT id FROM inserted`,
          ).rows,
        ).toEqual([{ id: 7 }]);
      }
      pending = pendingToken(db, "second");
      expect(pendingToken(db, "first")).toBe(before);
      // Closing another handle to this anchor cannot settle the writer's pending receipt.
      const reader = open();
      reader.close();
      expect(token(db, "second")).toBe(second);
    });
    expect(pending).not.toBe(second);
    expect(tokens(db)).toEqual([before, pending]);

    transaction(db, () => db.prepare(`SELECT count(*) FROM ${table}`).get());
    transaction(db, () => {});
    expect(tokens(db)).toEqual([before, pending]);

    const unscoped =
      kind === "plain"
        ? [
            `INSERT INTO ${table} VALUES (8); SELECT 1`,
            `WITH changed AS (UPDATE ${table} SET id = id + 1 RETURNING *) SELECT * FROM changed`,
          ]
        : [`SELECT source."id" INTO cte_copy FROM ${table} AS source`, "SELECT 1. INTO cte_number"];
    for (const sql of unscoped) {
      const previous = tokens(db);
      const write = () => db.exec(sql);
      if (kind === "plain") {
        transaction(db, write);
      } else {
        scoped(db, "second", write);
      }
      tokens(db).forEach((value, index) => expect(value).not.toBe(previous[index]));
    }
  });

  it("keeps read snapshots pure when columns use qualified SQL keywords", () => {
    const db = open();
    exec(db, 'CREATE TABLE keyword_entries ("update" integer, "into" integer)');
    exec(db, "INSERT INTO keyword_entries VALUES (7, 8)");
    const before = token(db, "first");
    expect(
      readOnly(db, "SELECT t.update, t . /* column */ into FROM keyword_entries AS t").rows,
    ).toEqual([{ update: 7, into: 8 }]);
    expect(token(db, "first")).toBe(before);
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
      expect(() => readOnly(reader, "SELECT merge FROM snapshot_entries")).toThrow(
        "PostgreSQL read snapshot cannot execute a mutation",
      );
      expect(token(writer, "entry")).toBe(before);
      expect(pendingToken(writer, "entry")).toBe(pending);
    });
    expect(token(writer, "entry")).toBe(pending);
    expect(query(reader, "SELECT * FROM snapshot_entries")).toEqual([{ merge: 7 }]);
  });

  it("releases evicted idle backends and their session locks", async () => {
    const dsn = new URL(connection!);
    const independent = () => {
      dsn.searchParams.set("application_name", randomUUID());
      return open(dsn.href);
    };
    const first = independent();
    const firstPid = pid(first);
    const lockKey = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16);
    run(() => first.prepare("SELECT pg_advisory_lock(?)").get(lockKey));
    close(first);
    for (let index = 0; index < 4; index++) {
      const next = independent();
      close(next);
    }

    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL lock_timeout = '5s'");
      await admin.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);
      expect(await backendRows(firstPid)).toEqual([]);
    } finally {
      await admin.query("ROLLBACK");
    }
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

    const uncommittedPid = pid(db);
    exec(db, "SELECT 1; BEGIN; INSERT INTO batch_entries VALUES (2)");
    expect(db.isTransaction).toBe(true);
    expect(token(db, "first")).toBe(committed);
    close(db);
    const reader = open();
    expect(pid(reader)).not.toBe(uncommittedPid);
    expect(rows(reader, "SELECT id FROM batch_entries")).toEqual([{ id: 1 }]);
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
  });

  it("inherits commit durability while applying settings with a quoted, comma-containing schema name", async () => {
    const namespace = `${schema}_"first,second`;
    const quoted = `"${namespace.replaceAll('"', '""')}"`;
    await admin.query(`CREATE SCHEMA ${quoted}`);
    const defaults = await admin.query<{ synchronous_commit: string }>(
      "SELECT current_setting('synchronous_commit') AS synchronous_commit",
    );
    const db = open(connection!, namespace, { lockTimeoutMs: 321, statementTimeoutMs: 654 });
    const settings = query(
      db,
      `SELECT
      current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('lock_timeout') AS lock_timeout,
      current_setting('statement_timeout') AS statement_timeout,
      current_setting('search_path') AS search_path, current_schema() AS schema`,
    );
    expect(settings).toEqual([
      {
        synchronous_commit: defaults.rows[0]?.synchronous_commit,
        lock_timeout: "321ms",
        statement_timeout: "654ms",
        search_path: quoted,
        schema: namespace,
      },
    ]);
  });
});
