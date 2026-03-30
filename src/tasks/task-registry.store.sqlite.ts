import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { resolveTaskRegistryDir, resolveTaskRegistrySqlitePath } from "./task-registry.paths.js";
import type { TaskEventRecord, TaskRecord } from "./task-registry.types.js";

type TaskRegistryRow = {
  task_id: string;
  runtime: TaskRecord["runtime"];
  source_id: string | null;
  requester_session_key: string;
  requester_origin_json: string | null;
  child_session_key: string | null;
  parent_task_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  label: string | null;
  task: string;
  status: TaskRecord["status"];
  delivery_status: TaskRecord["deliveryStatus"];
  notify_policy: TaskRecord["notifyPolicy"];
  created_at: number | bigint;
  started_at: number | bigint | null;
  ended_at: number | bigint | null;
  last_event_at: number | bigint | null;
  cleanup_after: number | bigint | null;
  error: string | null;
  progress_summary: string | null;
  terminal_summary: string | null;
  terminal_outcome: TaskRecord["terminalOutcome"] | null;
  recent_events_json: string | null;
  last_notified_event_at: number | bigint | null;
};

type TaskRegistryStatements = {
  selectAll: StatementSync;
  replaceRow: StatementSync;
  deleteRow: StatementSync;
  clearRows: StatementSync;
};

type TaskRegistryDatabase = {
  db: DatabaseSync;
  path: string;
  statements: TaskRegistryStatements;
};

let cachedDatabase: TaskRegistryDatabase | null = null;
const TASK_REGISTRY_DIR_MODE = 0o700;
const TASK_REGISTRY_FILE_MODE = 0o600;
const TASK_REGISTRY_SIDEcar_SUFFIXES = ["", "-shm", "-wal"] as const;

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToTaskRecord(row: TaskRegistryRow): TaskRecord {
  const requesterOrigin = parseJsonValue<DeliveryContext>(row.requester_origin_json);
  const recentEvents = parseJsonValue<TaskEventRecord[]>(row.recent_events_json);
  const startedAt = normalizeNumber(row.started_at);
  const endedAt = normalizeNumber(row.ended_at);
  const lastEventAt = normalizeNumber(row.last_event_at);
  const cleanupAfter = normalizeNumber(row.cleanup_after);
  const lastNotifiedEventAt = normalizeNumber(row.last_notified_event_at);
  return {
    taskId: row.task_id,
    runtime: row.runtime,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    requesterSessionKey: row.requester_session_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.child_session_key ? { childSessionKey: row.child_session_key } : {}),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    task: row.task,
    status: row.status,
    deliveryStatus: row.delivery_status,
    notifyPolicy: row.notify_policy,
    createdAt: normalizeNumber(row.created_at) ?? 0,
    ...(startedAt != null ? { startedAt } : {}),
    ...(endedAt != null ? { endedAt } : {}),
    ...(lastEventAt != null ? { lastEventAt } : {}),
    ...(cleanupAfter != null ? { cleanupAfter } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.progress_summary ? { progressSummary: row.progress_summary } : {}),
    ...(row.terminal_summary ? { terminalSummary: row.terminal_summary } : {}),
    ...(row.terminal_outcome ? { terminalOutcome: row.terminal_outcome } : {}),
    ...(recentEvents?.length ? { recentEvents } : {}),
    ...(lastNotifiedEventAt != null ? { lastNotifiedEventAt } : {}),
  };
}

function bindTaskRecord(record: TaskRecord) {
  return {
    task_id: record.taskId,
    runtime: record.runtime,
    source_id: record.sourceId ?? null,
    requester_session_key: record.requesterSessionKey,
    requester_origin_json: serializeJson(record.requesterOrigin),
    child_session_key: record.childSessionKey ?? null,
    parent_task_id: record.parentTaskId ?? null,
    agent_id: record.agentId ?? null,
    run_id: record.runId ?? null,
    label: record.label ?? null,
    task: record.task,
    status: record.status,
    delivery_status: record.deliveryStatus,
    notify_policy: record.notifyPolicy,
    created_at: record.createdAt,
    started_at: record.startedAt ?? null,
    ended_at: record.endedAt ?? null,
    last_event_at: record.lastEventAt ?? null,
    cleanup_after: record.cleanupAfter ?? null,
    error: record.error ?? null,
    progress_summary: record.progressSummary ?? null,
    terminal_summary: record.terminalSummary ?? null,
    terminal_outcome: record.terminalOutcome ?? null,
    recent_events_json: serializeJson(record.recentEvents),
    last_notified_event_at: record.lastNotifiedEventAt ?? null,
  };
}

function createStatements(db: DatabaseSync): TaskRegistryStatements {
  return {
    selectAll: db.prepare(`
      SELECT
        task_id,
        runtime,
        source_id,
        requester_session_key,
        requester_origin_json,
        child_session_key,
        parent_task_id,
        agent_id,
        run_id,
        label,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        started_at,
        ended_at,
        last_event_at,
        cleanup_after,
        error,
        progress_summary,
        terminal_summary,
        terminal_outcome,
        recent_events_json,
        last_notified_event_at
      FROM task_runs
      ORDER BY created_at ASC, task_id ASC
    `),
    replaceRow: db.prepare(`
      INSERT OR REPLACE INTO task_runs (
        task_id,
        runtime,
        source_id,
        requester_session_key,
        requester_origin_json,
        child_session_key,
        parent_task_id,
        agent_id,
        run_id,
        label,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        started_at,
        ended_at,
        last_event_at,
        cleanup_after,
        error,
        progress_summary,
        terminal_summary,
        terminal_outcome,
        recent_events_json,
        last_notified_event_at
      ) VALUES (
        @task_id,
        @runtime,
        @source_id,
        @requester_session_key,
        @requester_origin_json,
        @child_session_key,
        @parent_task_id,
        @agent_id,
        @run_id,
        @label,
        @task,
        @status,
        @delivery_status,
        @notify_policy,
        @created_at,
        @started_at,
        @ended_at,
        @last_event_at,
        @cleanup_after,
        @error,
        @progress_summary,
        @terminal_summary,
        @terminal_outcome,
        @recent_events_json,
        @last_notified_event_at
      )
    `),
    deleteRow: db.prepare(`DELETE FROM task_runs WHERE task_id = ?`),
    clearRows: db.prepare(`DELETE FROM task_runs`),
  };
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      task_id TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      source_id TEXT,
      requester_session_key TEXT NOT NULL,
      requester_origin_json TEXT,
      child_session_key TEXT,
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
      terminal_outcome TEXT,
      recent_events_json TEXT,
      last_notified_event_at INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_run_id ON task_runs(run_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_status ON task_runs(runtime, status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_cleanup_after ON task_runs(cleanup_after);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_last_event_at ON task_runs(last_event_at);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_task_runs_child_session_key ON task_runs(child_session_key);`,
  );
}

function ensureTaskRegistryPermissions(pathname: string) {
  const dir = resolveTaskRegistryDir(process.env);
  mkdirSync(dir, { recursive: true, mode: TASK_REGISTRY_DIR_MODE });
  chmodSync(dir, TASK_REGISTRY_DIR_MODE);
  for (const suffix of TASK_REGISTRY_SIDEcar_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    chmodSync(candidate, TASK_REGISTRY_FILE_MODE);
  }
}

function openTaskRegistryDatabase(): TaskRegistryDatabase {
  const pathname = resolveTaskRegistrySqlitePath(process.env);
  if (cachedDatabase && cachedDatabase.path === pathname) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabase.db.close();
    cachedDatabase = null;
  }
  ensureTaskRegistryPermissions(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA synchronous = NORMAL;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  ensureSchema(db);
  ensureTaskRegistryPermissions(pathname);
  cachedDatabase = {
    db,
    path: pathname,
    statements: createStatements(db),
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (statements: TaskRegistryStatements) => void) {
  const { db, path, statements } = openTaskRegistryDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    write(statements);
    db.exec("COMMIT");
    ensureTaskRegistryPermissions(path);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function loadTaskRegistrySnapshotFromSqlite(): Map<string, TaskRecord> {
  const { statements } = openTaskRegistryDatabase();
  const rows = statements.selectAll.all() as TaskRegistryRow[];
  return new Map(rows.map((row) => [row.task_id, rowToTaskRecord(row)]));
}

export function saveTaskRegistrySnapshotToSqlite(tasks: ReadonlyMap<string, TaskRecord>) {
  withWriteTransaction((statements) => {
    statements.clearRows.run();
    for (const task of tasks.values()) {
      statements.replaceRow.run(bindTaskRecord(task));
    }
  });
}

export function upsertTaskRegistryRecordToSqlite(task: TaskRecord) {
  const store = openTaskRegistryDatabase();
  store.statements.replaceRow.run(bindTaskRecord(task));
  ensureTaskRegistryPermissions(store.path);
}

export function deleteTaskRegistryRecordFromSqlite(taskId: string) {
  const store = openTaskRegistryDatabase();
  store.statements.deleteRow.run(taskId);
  ensureTaskRegistryPermissions(store.path);
}

export function closeTaskRegistrySqliteStore() {
  if (!cachedDatabase) {
    return;
  }
  cachedDatabase.db.close();
  cachedDatabase = null;
}
