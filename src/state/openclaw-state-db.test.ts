import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  collectSqliteSchemaShape,
  createSqliteSchemaShapeFromSql,
} from "./sqlite-schema-shape.test-support.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-db-"));
}

function readPragmaNumber(db: import("node:sqlite").DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma] ?? row?.timeout;
  return typeof value === "bigint" ? Number(value) : Number(value);
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("openclaw state database", () => {
  it("resolves under the shared state database directory", () => {
    const stateDir = createTempStateDir();

    expect(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir })).toBe(
      path.join(stateDir, "state", "openclaw.sqlite"),
    );
  });

  it("creates the shared state schema from the committed SQL shape", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(collectSqliteSchemaShape(database.db)).toEqual(
      createSqliteSchemaShapeFromSql(new URL("./openclaw-state-schema.sql", import.meta.url)),
    );
    expect(database.path).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
  });

  it("configures durable SQLite connection pragmas", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(readPragmaNumber(database.db, "busy_timeout")).toBe(30_000);
    expect(readPragmaNumber(database.db, "foreign_keys")).toBe(1);
    expect(readPragmaNumber(database.db, "synchronous")).toBe(1);
    expect(readPragmaNumber(database.db, "wal_autocheckpoint")).toBe(1000);
    const journalMode = database.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("wal");
  });

  it("does not chmod shared parent directories for explicit database paths", () => {
    const databasePath = path.join(
      os.tmpdir(),
      `openclaw-explicit-state-${process.pid}-${Date.now()}.sqlite`,
    );

    expect(() => openOpenClawStateDatabase({ path: databasePath })).not.toThrow();
    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it("uses savepoints for nested write transaction rollback", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    runOpenClawStateWriteTransaction((database) => {
      database.db
        .prepare("INSERT INTO kv(scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
        .run("test", "outer", "{}", 1);
      expect(() =>
        runOpenClawStateWriteTransaction((inner) => {
          inner.db
            .prepare("INSERT INTO kv(scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
            .run("test", "inner", "{}", 2);
          throw new Error("rollback nested");
        }, options),
      ).toThrow("rollback nested");
    }, options);

    const database = openOpenClawStateDatabase(options);
    expect(
      database.db
        .prepare("SELECT key FROM kv WHERE scope = ? ORDER BY key")
        .all("test")
        .map((row) => (row as { key: string }).key),
    ).toEqual(["outer"]);
  });

  it("rejects Promise-returning write transactions", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    expect(() =>
      runOpenClawStateWriteTransaction(async () => {
        return "not sync";
      }, options),
    ).toThrow("must be synchronous");

    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        database.db
          .prepare("INSERT INTO kv(scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
          .run("test", "after", "{}", 3);
      }, options),
    ).not.toThrow();
  });

  it("upgrades existing cron job tables with explicit sort order", () => {
    const stateDir = createTempStateDir();
    const dbPath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const oldDb = new sqlite.DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE cron_jobs (
        store_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        job_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store_key, job_id)
      );
      CREATE INDEX idx_cron_jobs_store_updated
        ON cron_jobs(store_key, updated_at DESC, job_id);
      PRAGMA user_version = 12;
    `);
    oldDb.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    const columns = database.db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{
      name?: unknown;
    }>;
    const index = database.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_cron_jobs_store_updated") as { sql?: string } | undefined;
    const version = database.db.prepare("PRAGMA user_version").get() as {
      user_version?: number;
    };

    expect(columns.some((column) => column.name === "sort_order")).toBe(true);
    expect(index?.sql).toContain("sort_order ASC");
    expect(version.user_version).toBe(20);
  });

  it("migrates legacy cron runtime state from kv into cron job columns", () => {
    const stateDir = createTempStateDir();
    const dbPath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const oldDb = new sqlite.DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE cron_jobs (
        store_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        job_json TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store_key, job_id)
      );
      INSERT INTO cron_jobs (store_key, job_id, job_json, sort_order, updated_at)
      VALUES ('/tmp/cron/jobs.json', 'job-1', '{"id":"job-1"}', 0, 1);
      INSERT INTO kv (scope, key, value_json, updated_at)
      VALUES (
        'cron.jobs.state',
        '/tmp/cron/jobs.json',
        '{"version":1,"jobs":{"job-1":{"updatedAtMs":42,"scheduleIdentity":"every:60000","state":{"nextRunAtMs":100}}}}',
        2
      );
      PRAGMA user_version = 18;
    `);
    oldDb.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(
      database.db
        .prepare(
          "SELECT state_json, runtime_updated_at_ms, schedule_identity FROM cron_jobs WHERE job_id = ?",
        )
        .get("job-1"),
    ).toEqual({
      state_json: '{"nextRunAtMs":100}',
      runtime_updated_at_ms: 42,
      schedule_identity: "every:60000",
    });
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM kv WHERE scope = ?")
        .get("cron.jobs.state"),
    ).toEqual({ count: 0 });
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 20 });
  });

  it("migrates persisted subagent runs from kv into subagent run rows", () => {
    const stateDir = createTempStateDir();
    const dbPath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const oldDb = new sqlite.DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      INSERT INTO kv (scope, key, value_json, updated_at)
      VALUES (
        'subagent_runs',
        'run-1',
        '{"runId":"run-1","childSessionKey":"agent:main:subagent:child","requesterSessionKey":"agent:main:main","requesterDisplayKey":"main","task":"migrate subagent","cleanup":"keep","createdAt":1,"startedAt":2,"cleanupHandled":false,"requesterOrigin":{"channel":"telegram","accountId":"acct-1"}}',
        3
      );
      PRAGMA user_version = 19;
    `);
    oldDb.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(
      database.db
        .prepare(
          "SELECT run_id, child_session_key, requester_session_key, task, cleanup_handled, requester_origin_json FROM subagent_runs WHERE run_id = ?",
        )
        .get("run-1"),
    ).toEqual({
      run_id: "run-1",
      child_session_key: "agent:main:subagent:child",
      requester_session_key: "agent:main:main",
      task: "migrate subagent",
      cleanup_handled: 0,
      requester_origin_json: '{"channel":"telegram","accountId":"acct-1"}',
    });
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM kv WHERE scope = ?").get("subagent_runs"),
    ).toEqual({ count: 0 });
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 20 });
  });

  it("upgrades task delivery state with task-run cascade integrity", () => {
    const stateDir = createTempStateDir();
    const dbPath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const oldDb = new sqlite.DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE task_runs (
        task_id TEXT NOT NULL PRIMARY KEY,
        runtime TEXT NOT NULL,
        task_kind TEXT,
        source_id TEXT,
        requester_session_key TEXT,
        owner_key TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        child_session_key TEXT,
        parent_flow_id TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
      CREATE TABLE task_delivery_state (
        task_id TEXT NOT NULL PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
      INSERT INTO task_runs (
        task_id,
        runtime,
        owner_key,
        scope_kind,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at
      )
      VALUES (
        'task-live',
        'acp',
        'agent:main:main',
        'session',
        'live task',
        'running',
        'pending',
        'done_only',
        1
      );
      INSERT INTO task_delivery_state (
        task_id,
        requester_origin_json,
        last_notified_event_at
      )
      VALUES
        ('task-live', '{}', 1),
        ('task-orphan', '{}', 2);
      PRAGMA user_version = 15;
    `);
    oldDb.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    const foreignKeys = database.db
      .prepare("PRAGMA foreign_key_list(task_delivery_state)")
      .all() as Array<{ table?: string; from?: string; to?: string; on_delete?: string }>;
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "task_runs",
          from: "task_id",
          to: "task_id",
          on_delete: "CASCADE",
        }),
      ]),
    );
    expect(
      database.db.prepare("SELECT task_id FROM task_delivery_state ORDER BY task_id").all(),
    ).toEqual([{ task_id: "task-live" }]);
    database.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run("task-live");
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM task_delivery_state").get()).toEqual({
      count: 0,
    });
  });
});
