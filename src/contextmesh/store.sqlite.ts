import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import { defaultContextMeshState } from "./defaults.js";
import { resolveContextMeshDir } from "./state.js";
import type {
  ContextMeshAuditRecord,
  ContextMeshJobRecord,
  ContextMeshState,
  ContextMeshTaskRecord,
  ContextMeshWorkerRecord,
} from "./types.js";

const CONTEXTMESH_SCHEMA_VERSION = 1;
const CONTEXTMESH_DIR_MODE = 0o700;
const CONTEXTMESH_FILE_MODE = 0o600;
const CONTEXTMESH_FILE_NAME = "contextmesh.sqlite";
const CONTEXTMESH_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

type JsonOnlyRow = { value_json: string };
type ConfigRow = { key: string; value_json: string };
type UserVersionRow = { user_version?: number | bigint };

type ContextMeshStatements = {
  replaceConfig: StatementSync;
  selectConfig: StatementSync;
  replaceWorker: StatementSync;
  selectWorkers: StatementSync;
  clearWorkers: StatementSync;
  replaceJob: StatementSync;
  selectJobs: StatementSync;
  clearJobs: StatementSync;
  replaceTask: StatementSync;
  selectTasks: StatementSync;
  clearTasks: StatementSync;
  insertAudit: StatementSync;
  selectAudit: StatementSync;
  clearAudit: StatementSync;
  insertBenchmark: StatementSync;
  selectBenchmarks: StatementSync;
};

type ContextMeshDatabase = {
  db: DatabaseSync;
  path: string;
  statements: ContextMeshStatements;
  walMaintenance: SqliteWalMaintenance;
};

let cachedDatabase: ContextMeshDatabase | null = null;

function resolveContextMeshSqlitePath(): string {
  return path.join(resolveContextMeshDir(), CONTEXTMESH_FILE_NAME);
}

function normalizeNumber(value: number | bigint | null | undefined): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : 0;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as UserVersionRow | undefined;
  return normalizeNumber(row?.user_version);
}

function ensureSchema(db: DatabaseSync, pathname: string) {
  const userVersion = getUserVersion(db);
  if (userVersion > CONTEXTMESH_SCHEMA_VERSION) {
    throw new Error(
      `ContextMesh schema version ${userVersion} is newer than supported version ${CONTEXTMESH_SCHEMA_VERSION}: ${pathname}`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS contextmesh_config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contextmesh_workers (
      worker_id TEXT PRIMARY KEY,
      worker_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contextmesh_jobs (
      job_id TEXT PRIMARY KEY,
      job_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contextmesh_tasks (
      task_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      task_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contextmesh_tasks_job_id ON contextmesh_tasks(job_id);
    CREATE TABLE IF NOT EXISTS contextmesh_audit (
      audit_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      audit_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contextmesh_benchmarks (
      benchmark_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      benchmark_json TEXT NOT NULL
    );
    PRAGMA user_version = ${CONTEXTMESH_SCHEMA_VERSION};
  `);
}

function createStatements(db: DatabaseSync): ContextMeshStatements {
  return {
    replaceConfig: db.prepare(`
      INSERT INTO contextmesh_config (key, value_json)
      VALUES (@key, @value_json)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `),
    selectConfig: db.prepare(`SELECT key, value_json FROM contextmesh_config ORDER BY key ASC`),
    replaceWorker: db.prepare(`
      INSERT INTO contextmesh_workers (worker_id, worker_json)
      VALUES (@worker_id, @worker_json)
      ON CONFLICT(worker_id) DO UPDATE SET worker_json = excluded.worker_json
    `),
    selectWorkers: db.prepare(`SELECT worker_json AS value_json FROM contextmesh_workers ORDER BY worker_id ASC`),
    clearWorkers: db.prepare(`DELETE FROM contextmesh_workers`),
    replaceJob: db.prepare(`
      INSERT INTO contextmesh_jobs (job_id, job_json)
      VALUES (@job_id, @job_json)
      ON CONFLICT(job_id) DO UPDATE SET job_json = excluded.job_json
    `),
    selectJobs: db.prepare(`SELECT job_json AS value_json FROM contextmesh_jobs ORDER BY job_id ASC`),
    clearJobs: db.prepare(`DELETE FROM contextmesh_jobs`),
    replaceTask: db.prepare(`
      INSERT INTO contextmesh_tasks (task_id, job_id, task_json)
      VALUES (@task_id, @job_id, @task_json)
      ON CONFLICT(task_id) DO UPDATE SET job_id = excluded.job_id, task_json = excluded.task_json
    `),
    selectTasks: db.prepare(`SELECT task_json AS value_json FROM contextmesh_tasks ORDER BY job_id ASC, task_id ASC`),
    clearTasks: db.prepare(`DELETE FROM contextmesh_tasks`),
    insertAudit: db.prepare(`
      INSERT OR REPLACE INTO contextmesh_audit (audit_id, created_at, audit_json)
      VALUES (@audit_id, @created_at, @audit_json)
    `),
    selectAudit: db.prepare(`SELECT audit_json AS value_json FROM contextmesh_audit ORDER BY created_at DESC, audit_id DESC`),
    clearAudit: db.prepare(`DELETE FROM contextmesh_audit`),
    insertBenchmark: db.prepare(`
      INSERT OR REPLACE INTO contextmesh_benchmarks (benchmark_id, created_at, benchmark_json)
      VALUES (@benchmark_id, @created_at, @benchmark_json)
    `),
    selectBenchmarks: db.prepare(`SELECT benchmark_json AS value_json FROM contextmesh_benchmarks ORDER BY created_at DESC, benchmark_id DESC`),
  };
}

function ensureFilesystem(pathname: string) {
  const dir = path.dirname(pathname);
  mkdirSync(dir, { recursive: true, mode: CONTEXTMESH_DIR_MODE });
  chmodSync(dir, CONTEXTMESH_DIR_MODE);
  for (const suffix of CONTEXTMESH_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (existsSync(candidate)) {
      chmodSync(candidate, CONTEXTMESH_FILE_MODE);
    }
  }
}

function openDatabase(): ContextMeshDatabase {
  if (cachedDatabase) {
    return cachedDatabase;
  }
  const pathname = resolveContextMeshSqlitePath();
  ensureFilesystem(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  ensureSchema(db, pathname);
  const walMaintenance = configureSqliteWalMaintenance(db);
  const statements = createStatements(db);
  cachedDatabase = { db, path: pathname, statements, walMaintenance };
  ensureFilesystem(pathname);
  return cachedDatabase;
}

export function loadContextMeshStateFromSqlite(): ContextMeshState {
  const database = openDatabase();
  const state = defaultContextMeshState();
  for (const row of database.statements.selectConfig.all() as ConfigRow[]) {
    if (row.key === "config") {
      state.config = { ...state.config, ...parseJson(row.value_json) };
    } else if (row.key === "metrics") {
      state.metrics = { ...state.metrics, ...parseJson(row.value_json) };
    }
  }
  state.workers = (database.statements.selectWorkers.all() as JsonOnlyRow[]).map((row) =>
    parseJson<ContextMeshWorkerRecord>(row.value_json),
  );
  state.jobs = (database.statements.selectJobs.all() as JsonOnlyRow[]).map((row) =>
    parseJson<ContextMeshJobRecord>(row.value_json),
  );
  state.tasks = (database.statements.selectTasks.all() as JsonOnlyRow[]).map((row) =>
    parseJson<ContextMeshTaskRecord>(row.value_json),
  );
  state.audit = (database.statements.selectAudit.all() as JsonOnlyRow[]).map((row) =>
    parseJson<ContextMeshAuditRecord>(row.value_json),
  );
  return state;
}

export function saveContextMeshStateToSqlite(state: ContextMeshState): void {
  const database = openDatabase();
  database.db.exec("BEGIN IMMEDIATE");
  try {
    database.statements.replaceConfig.run({ key: "config", value_json: JSON.stringify(state.config) });
    database.statements.replaceConfig.run({ key: "metrics", value_json: JSON.stringify(state.metrics) });
    database.statements.clearWorkers.run();
    for (const worker of state.workers) {
      database.statements.replaceWorker.run({
        worker_id: worker.id,
        worker_json: JSON.stringify(worker),
      });
    }
    database.statements.clearJobs.run();
    for (const job of state.jobs) {
      database.statements.replaceJob.run({ job_id: job.id, job_json: JSON.stringify(job) });
    }
    database.statements.clearTasks.run();
    for (const task of state.tasks) {
      database.statements.replaceTask.run({
        task_id: task.id,
        job_id: task.jobId,
        task_json: JSON.stringify(task),
      });
    }
    database.statements.clearAudit.run();
    for (const audit of state.audit) {
      database.statements.insertAudit.run({
        audit_id: audit.id,
        created_at: audit.createdAt,
        audit_json: JSON.stringify(audit),
      });
    }
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
  ensureFilesystem(database.path);
}

export function appendContextMeshBenchmarkResult(result: Record<string, unknown>): void {
  const database = openDatabase();
  const benchmarkId = String(result.benchmarkId ?? result.jobId ?? `benchmark-${Date.now()}`);
  const createdAt = String(result.createdAt ?? new Date().toISOString());
  database.statements.insertBenchmark.run({
    benchmark_id: benchmarkId,
    created_at: createdAt,
    benchmark_json: JSON.stringify({ ...result, benchmarkId, createdAt }),
  });
  ensureFilesystem(database.path);
}

export function listContextMeshBenchmarkResults(): Array<Record<string, unknown>> {
  const database = openDatabase();
  return (database.statements.selectBenchmarks.all() as JsonOnlyRow[]).map((row) =>
    parseJson<Record<string, unknown>>(row.value_json),
  );
}

export function closeContextMeshStoreForTests(): void {
  if (!cachedDatabase) {
    return;
  }
  const current = cachedDatabase;
  cachedDatabase = null;
  current.walMaintenance.close();
  current.db.close();
}
