import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { migrateLegacyTasks } from "./migration.js";
import { MinionStore } from "./store.js";

let tmpDir: string;
let minionStore: MinionStore;
let legacyDir: string;
let legacyPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-migration-"));
  minionStore = MinionStore.openAt(path.join(tmpDir, "minions", "queue.sqlite"));
  legacyDir = path.join(tmpDir, "tasks");
  mkdirSync(legacyDir, { recursive: true });
  legacyPath = path.join(legacyDir, "runs.sqlite");
});

afterEach(() => {
  minionStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function createLegacyDb() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(legacyPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      task_id TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      child_session_key TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      last_event_at INTEGER,
      error TEXT,
      progress_summary TEXT
    )
  `);
  return db;
}

function insertLegacyTask(
  db: ReturnType<typeof createLegacyDb>,
  opts: {
    taskId: string;
    runtime?: string;
    task?: string;
    status: string;
    runId?: string;
  },
) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO task_runs (task_id, runtime, task, status, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    opts.taskId,
    opts.runtime ?? "subagent",
    opts.task ?? "test task",
    opts.status,
    opts.runId ?? null,
    now,
  );
}

describe("migrateLegacyTasks", () => {
  it("returns null when no legacy file exists", () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    const result = migrateLegacyTasks(minionStore, env);
    expect(result).toBeNull();
  });

  it("imports queued and running tasks as waiting with registered handler names", () => {
    const db = createLegacyDb();
    insertLegacyTask(db, { taskId: "t1", status: "queued", runId: "run-1" });
    insertLegacyTask(db, { taskId: "t2", status: "running", runId: "run-2" });
    insertLegacyTask(db, { taskId: "t3", status: "succeeded" });
    insertLegacyTask(db, { taskId: "t4", status: "failed" });
    db.close();

    const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    const result = migrateLegacyTasks(minionStore, env);
    vi.unstubAllEnvs();

    expect(result).not.toBeNull();
    expect(result!.imported).toBe(2);
    expect(result!.skipped).toBe(2);

    const rows = minionStore.db
      .prepare("SELECT * FROM minion_jobs ORDER BY name")
      .all() as Array<{ status: string; name: string; data: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("waiting");
      expect(row.name).toBe("subagent.spawn");
      const data = JSON.parse(row.data);
      expect(data.reason).toBe("imported_live");
    }
  });

  it("renames legacy files including WAL sidecars", () => {
    const db = createLegacyDb();
    insertLegacyTask(db, { taskId: "t1", status: "running" });
    db.close();

    const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    const result = migrateLegacyTasks(minionStore, env);
    vi.unstubAllEnvs();

    expect(result).not.toBeNull();
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(result!.renamedTo)).toBe(true);
  });

  it("is idempotent (no-ops if legacy already renamed)", () => {
    const db = createLegacyDb();
    insertLegacyTask(db, { taskId: "t1", status: "running" });
    db.close();

    const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    const first = migrateLegacyTasks(minionStore, env);
    expect(first).not.toBeNull();

    const second = migrateLegacyTasks(minionStore, env);
    expect(second).toBeNull();
    vi.unstubAllEnvs();
  });
});
