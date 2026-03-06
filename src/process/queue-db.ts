import fs from "node:fs";
import path from "path";
import Database from "better-sqlite3";
import { resolveStateDir } from "../config/paths.js";
import { diagnosticLogger as diag } from "../logging/diagnostic.js";

export type TaskStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface TaskRecord {
  id: number;
  lane: string;
  task_type: string;
  payload: string; // JSON
  status: TaskStatus;
  error_msg: string | null;
  result: string | null; // JSON-serialized result
  retry_count: number;
  created_at: number;
  updated_at: number;
}

const DB_FILENAME = "command-queue.db";
let db: Database.Database | null = null;

export function initQueueDB(customDbPath?: string): Database.Database {
  if (db) {
    return db;
  }
  const dbPath = customDbPath ?? path.join(resolveStateDir(), DB_FILENAME);
  diag.debug(`Initializing command queue database at ${dbPath}`);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane TEXT NOT NULL,
      task_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      error_msg TEXT,
      result TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_queue_lane_status ON task_queue(lane, status);
  `);
  try {
    db.exec(`ALTER TABLE task_queue ADD COLUMN result TEXT`);
  } catch {
    // Column already exists, ignore
  }

  return db;
}

export function closeQueueDB() {
  if (db) {
    db.close();
    db = null;
  }
}

export function insertTask(lane: string, taskType: string, payload: unknown): number {
  const conn = initQueueDB();
  const now = Date.now();
  const stmt = conn.prepare(`
    INSERT INTO task_queue (lane, task_type, payload, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(lane, taskType, JSON.stringify(payload), "PENDING", now, now);
  return info.lastInsertRowid as number;
}

export function claimNextPendingTask(lane: string): TaskRecord | null {
  const conn = initQueueDB();
  const now = Date.now();
  let claimedTask: TaskRecord | null = null;

  const transaction = conn.transaction(() => {
    const row = conn
      .prepare(`
      SELECT * FROM task_queue
      WHERE lane = ? AND status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT 1
    `)
      .get(lane) as TaskRecord | undefined;

    if (row) {
      conn
        .prepare(`
        UPDATE task_queue
        SET status = 'RUNNING', updated_at = ?
        WHERE id = ?
      `)
        .run(now, row.id);

      claimedTask = { ...row, status: "RUNNING", updated_at: now };
    }
  });

  transaction();
  return claimedTask;
}

export function resolveTask(id: number, result?: unknown) {
  const conn = initQueueDB();
  const resultJson = result !== undefined ? JSON.stringify(result) : null;
  conn
    .prepare(`
    UPDATE task_queue
    SET status = 'COMPLETED', result = ?, updated_at = ?
    WHERE id = ?
  `)
    .run(resultJson, Date.now(), id);
}

/**
 * Query the result of a completed task, useful for result retrieval after process restart.
 * Returns null if the task does not exist or has not yet completed.
 */
export function getTaskResult(
  id: number,
): { status: TaskStatus; result: unknown; error_msg: string | null } | null {
  const conn = initQueueDB();
  const row = conn
    .prepare("SELECT status, result, error_msg FROM task_queue WHERE id = ?")
    .get(id) as { status: TaskStatus; result: string | null; error_msg: string | null } | undefined;
  if (!row) {
    return null;
  }
  return {
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
    error_msg: row.error_msg,
  };
}

/**
 * Query the latest N completed/failed task results for a given taskType.
 * Useful for batch recovery after process restart.
 */
export function getRecentResults(
  taskType: string,
  limit = 20,
): Array<{
  id: number;
  status: TaskStatus;
  result: unknown;
  error_msg: string | null;
  created_at: number;
}> {
  const conn = initQueueDB();
  const rows = conn
    .prepare(
      `SELECT id, status, result, error_msg, created_at FROM task_queue
       WHERE task_type = ? AND status IN ('COMPLETED', 'FAILED')
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(taskType, limit) as Array<{
    id: number;
    status: TaskStatus;
    result: string | null;
    error_msg: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    result: r.result ? JSON.parse(r.result) : null,
    error_msg: r.error_msg,
    created_at: r.created_at,
  }));
}

export function rejectTask(id: number, errorMsg: string) {
  const conn = initQueueDB();
  conn
    .prepare(`
    UPDATE task_queue
    SET status = 'FAILED', error_msg = ?, updated_at = ?
    WHERE id = ?
  `)
    .run(errorMsg, Date.now(), id);
}

export function countQueueByStatus(lane: string, status?: TaskStatus): number {
  const conn = initQueueDB();
  if (status) {
    const row = conn
      .prepare("SELECT COUNT(*) as cnt FROM task_queue WHERE lane = ? AND status = ?")
      .get(lane, status) as { cnt: number };
    return row.cnt;
  } else {
    const row = conn
      .prepare(
        "SELECT COUNT(*) as cnt FROM task_queue WHERE lane = ? AND status IN ('PENDING', 'RUNNING')",
      )
      .get(lane) as { cnt: number };
    return row.cnt;
  }
}

export function countTotalQueue(): number {
  const conn = initQueueDB();
  const row = conn
    .prepare("SELECT COUNT(*) as cnt FROM task_queue WHERE status IN ('PENDING', 'RUNNING')")
    .get() as { cnt: number };
  return row.cnt;
}

export function clearLaneTasks(lane: string): number {
  const conn = initQueueDB();
  const info = conn
    .prepare("DELETE FROM task_queue WHERE lane = ? AND status = 'PENDING'")
    .run(lane);
  return info.changes;
}

/**
 * Get the list of PENDING task IDs for a given lane (called before clearLaneTasks to reject in-memory Promises).
 */
export function getPendingTaskIdsForLane(lane: string): number[] {
  const conn = initQueueDB();
  const rows = conn
    .prepare("SELECT id FROM task_queue WHERE lane = ? AND status = 'PENDING'")
    .all(lane) as { id: number }[];
  return rows.map((r) => r.id);
}

export function recoverRunningTasks(): string[] {
  const conn = initQueueDB();
  const affectedLanes = new Set<string>();
  const transaction = conn.transaction(() => {
    const rows = conn
      .prepare("SELECT DISTINCT lane FROM task_queue WHERE status = 'RUNNING'")
      .all() as { lane: string }[];
    rows.forEach((r) => affectedLanes.add(r.lane));
    conn
      .prepare("UPDATE task_queue SET status = 'PENDING', updated_at = ? WHERE status = 'RUNNING'")
      .run(Date.now());
  });
  transaction();
  return Array.from(affectedLanes);
}

export function hasActiveTasks(): boolean {
  const conn = initQueueDB();
  const row = conn
    .prepare(`SELECT COUNT(*) as cnt FROM task_queue WHERE status = 'RUNNING'`)
    .get() as { cnt: number };
  return row.cnt > 0;
}

export function getPendingLanes(): string[] {
  const conn = initQueueDB();
  const rows = conn
    .prepare("SELECT DISTINCT lane FROM task_queue WHERE status = 'PENDING'")
    .all() as { lane: string }[];
  return rows.map((r) => r.lane);
}

export function markStaleTasks(reason: string = "stale: process restarted"): number {
  const conn = initQueueDB();
  const info = conn
    .prepare(
      "UPDATE task_queue SET status = 'FAILED', error_msg = ?, updated_at = ? WHERE status IN ('PENDING', 'RUNNING')",
    )
    .run(reason, Date.now());
  return info.changes;
}

export function getRecoverableTasks(): TaskRecord[] {
  const conn = initQueueDB();
  return conn
    .prepare("SELECT * FROM task_queue WHERE status = 'PENDING' ORDER BY id ASC")
    .all() as TaskRecord[];
}
