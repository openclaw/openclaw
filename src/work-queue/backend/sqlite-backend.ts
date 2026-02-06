import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  WorkItem,
  WorkItemExecution,
  WorkItemListOptions,
  WorkItemOutcome,
  WorkItemPatch,
  WorkItemPriority,
  WorkItemStatus,
  WorkQueue,
  WorkQueueStats,
} from "../types.js";
import type { WorkQueueBackend, WorkQueueBackendTransaction } from "./types.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

const priorityRank: Record<WorkItemPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function normalizeArray<T>(value?: T | T[]): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

function parseJson<T>(raw: string | null | undefined): T | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function encodeJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

function matchesTags(candidate: string[] | undefined, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) {
    return true;
  }
  if (!candidate || candidate.length === 0) {
    return false;
  }
  return tags.every((tag) => candidate.includes(tag));
}

export class SqliteWorkQueueBackend implements WorkQueueBackend {
  private db: DatabaseSync | null = null;

  constructor(private dbPath: string) {}

  async initialize(): Promise<void> {
    if (this.db) {
      return;
    }
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.ensureSchema();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private ensureSchema() {
    if (!this.db) {
      return;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workstream_notes (
        id          TEXT PRIMARY KEY,
        workstream  TEXT NOT NULL,
        item_id     TEXT,
        kind        TEXT NOT NULL DEFAULT 'context',
        content     TEXT NOT NULL,
        metadata_json TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        created_by_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_workstream_notes_ws
        ON workstream_notes(workstream, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workstream_notes_item
        ON workstream_notes(item_id);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_queues (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        concurrency_limit INTEGER DEFAULT 1,
        default_priority TEXT DEFAULT 'medium',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        queue_id TEXT NOT NULL REFERENCES work_queues(id),
        title TEXT NOT NULL,
        description TEXT,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        status_reason TEXT,
        parent_item_id TEXT REFERENCES work_items(id),
        depends_on_json TEXT,
        blocked_by_json TEXT,
        created_by_json TEXT,
        assigned_to_json TEXT,
        priority TEXT NOT NULL DEFAULT 'medium',
        workstream TEXT,
        tags_json TEXT,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_work_items_queue_status
        ON work_items(queue_id, status);
      CREATE INDEX IF NOT EXISTS idx_work_items_priority
        ON work_items(priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_work_items_parent
        ON work_items(parent_item_id);
      CREATE INDEX IF NOT EXISTS idx_work_items_workstream
        ON work_items(workstream);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_item_executions (
        id             TEXT PRIMARY KEY,
        item_id        TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        session_key    TEXT NOT NULL,
        outcome        TEXT NOT NULL,
        error          TEXT,
        started_at     TEXT NOT NULL,
        completed_at   TEXT NOT NULL,
        duration_ms    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_executions_item
        ON work_item_executions(item_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS work_item_transcripts (
        id             TEXT PRIMARY KEY,
        item_id        TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        execution_id   TEXT REFERENCES work_item_executions(id) ON DELETE SET NULL,
        session_key    TEXT NOT NULL,
        transcript_json TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_transcripts_item
        ON work_item_transcripts(item_id);
    `);
    this.migrateSchema();
  }

  private migrateSchema() {
    if (!this.db) return;
    const cols = this.db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("workstream")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN workstream TEXT");
    }
    if (!colNames.has("retry_count")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN retry_count INTEGER DEFAULT 0");
    }
    if (!colNames.has("max_retries")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN max_retries INTEGER");
    }
    if (!colNames.has("deadline")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN deadline TEXT");
    }
    if (!colNames.has("last_outcome")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN last_outcome TEXT");
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("WorkQueue backend not initialized");
    }
    return this.db;
  }

  /** Expose the raw DB handle for co-located stores (e.g. workstream notes). */
  getDb(): DatabaseSync | null {
    return this.db;
  }

  async beginTransaction(): Promise<WorkQueueBackendTransaction> {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    return {
      async commit() {
        db.exec("COMMIT");
      },
      async rollback() {
        db.exec("ROLLBACK");
      },
    };
  }

  private mapQueue(row: {
    id: string;
    agent_id: string;
    name: string;
    concurrency_limit: number;
    default_priority: WorkItemPriority;
    created_at: string;
    updated_at: string;
  }): WorkQueue {
    return {
      id: row.id,
      agentId: row.agent_id,
      name: row.name,
      concurrencyLimit: row.concurrency_limit,
      defaultPriority: row.default_priority,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapItem(row: {
    id: string;
    queue_id: string;
    title: string;
    description: string | null;
    payload_json: string | null;
    status: WorkItemStatus;
    status_reason: string | null;
    parent_item_id: string | null;
    depends_on_json: string | null;
    blocked_by_json: string | null;
    created_by_json: string | null;
    assigned_to_json: string | null;
    priority: WorkItemPriority;
    workstream: string | null;
    tags_json: string | null;
    result_json: string | null;
    error_json: string | null;
    retry_count: number | null;
    max_retries: number | null;
    deadline: string | null;
    last_outcome: string | null;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    completed_at: string | null;
  }): WorkItem {
    return {
      id: row.id,
      queueId: row.queue_id,
      title: row.title,
      description: row.description ?? undefined,
      payload: parseJson(row.payload_json),
      status: row.status,
      statusReason: row.status_reason ?? undefined,
      parentItemId: row.parent_item_id ?? undefined,
      dependsOn: parseJson(row.depends_on_json),
      blockedBy: parseJson(row.blocked_by_json),
      createdBy: parseJson(row.created_by_json),
      assignedTo: parseJson(row.assigned_to_json),
      priority: row.priority,
      workstream: row.workstream ?? undefined,
      tags: parseJson(row.tags_json),
      result: parseJson(row.result_json),
      error: parseJson(row.error_json),
      retryCount: row.retry_count ?? undefined,
      maxRetries: row.max_retries ?? undefined,
      deadline: row.deadline ?? undefined,
      lastOutcome: (row.last_outcome as WorkItemOutcome) ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
    };
  }

  async createQueue(queue: Omit<WorkQueue, "createdAt" | "updatedAt">): Promise<WorkQueue> {
    const db = this.requireDb();
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO work_queues (id, agent_id, name, concurrency_limit, default_priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      queue.id,
      queue.agentId,
      queue.name,
      queue.concurrencyLimit,
      queue.defaultPriority,
      now,
      now,
    );
    return { ...queue, createdAt: now, updatedAt: now };
  }

  async getQueue(queueId: string): Promise<WorkQueue | null> {
    const db = this.requireDb();
    const row = db
      .prepare(
        `
        SELECT id, agent_id, name, concurrency_limit, default_priority, created_at, updated_at
        FROM work_queues
        WHERE id = ?
      `,
      )
      .get(queueId) as ReturnType<SqliteWorkQueueBackend["mapQueue"]> | undefined;
    return row ? this.mapQueue(row as any) : null;
  }

  async getQueueByAgentId(agentId: string): Promise<WorkQueue | null> {
    const db = this.requireDb();
    const row = db
      .prepare(
        `
        SELECT id, agent_id, name, concurrency_limit, default_priority, created_at, updated_at
        FROM work_queues
        WHERE agent_id = ?
      `,
      )
      .get(agentId) as ReturnType<SqliteWorkQueueBackend["mapQueue"]> | undefined;
    return row ? this.mapQueue(row as any) : null;
  }

  async listQueues(opts?: { agentId?: string }): Promise<WorkQueue[]> {
    const db = this.requireDb();
    const agentId = opts?.agentId?.trim();
    const rows = agentId
      ? db
          .prepare(
            `
            SELECT id, agent_id, name, concurrency_limit, default_priority, created_at, updated_at
            FROM work_queues
            WHERE agent_id = ?
            ORDER BY created_at ASC
          `,
          )
          .all(agentId)
      : db
          .prepare(
            `
            SELECT id, agent_id, name, concurrency_limit, default_priority, created_at, updated_at
            FROM work_queues
            ORDER BY created_at ASC
          `,
          )
          .all();
    return (rows as any[]).map((row) => this.mapQueue(row));
  }

  async updateQueue(queueId: string, patch: Partial<WorkQueue>): Promise<WorkQueue> {
    const db = this.requireDb();
    const current = await this.getQueue(queueId);
    if (!current) {
      throw new Error(`Queue not found: ${queueId}`);
    }
    const now = new Date().toISOString();
    const updated = {
      ...current,
      ...patch,
      updatedAt: now,
    };
    db.prepare(
      `
      UPDATE work_queues
      SET name = ?, concurrency_limit = ?, default_priority = ?, updated_at = ?
      WHERE id = ?
    `,
    ).run(
      updated.name,
      updated.concurrencyLimit,
      updated.defaultPriority,
      updated.updatedAt,
      queueId,
    );
    return updated;
  }

  async deleteQueue(queueId: string): Promise<boolean> {
    const db = this.requireDb();
    const res = db.prepare("DELETE FROM work_queues WHERE id = ?").run(queueId);
    return res.changes > 0;
  }

  async createItem(item: Omit<WorkItem, "id" | "createdAt" | "updatedAt">): Promise<WorkItem> {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      `
      INSERT INTO work_items (
        id, queue_id, title, description, payload_json, status, status_reason, parent_item_id,
        depends_on_json, blocked_by_json, created_by_json, assigned_to_json, priority, workstream,
        tags_json, result_json, error_json, retry_count, max_retries, deadline, last_outcome,
        created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      item.queueId,
      item.title,
      item.description ?? null,
      encodeJson(item.payload),
      item.status,
      item.statusReason ?? null,
      item.parentItemId ?? null,
      encodeJson(item.dependsOn),
      encodeJson(item.blockedBy),
      encodeJson(item.createdBy),
      encodeJson(item.assignedTo),
      item.priority,
      item.workstream ?? null,
      encodeJson(item.tags),
      encodeJson(item.result),
      encodeJson(item.error),
      item.retryCount ?? 0,
      item.maxRetries ?? null,
      item.deadline ?? null,
      item.lastOutcome ?? null,
      now,
      now,
      item.startedAt ?? null,
      item.completedAt ?? null,
    );
    return { ...item, id, createdAt: now, updatedAt: now };
  }

  async getItem(itemId: string): Promise<WorkItem | null> {
    const db = this.requireDb();
    const row = db
      .prepare(
        `
        SELECT *
        FROM work_items
        WHERE id = ?
      `,
      )
      .get(itemId) as ReturnType<SqliteWorkQueueBackend["mapItem"]> | undefined;
    return row ? this.mapItem(row as any) : null;
  }

  async listItems(opts: WorkItemListOptions): Promise<WorkItem[]> {
    const db = this.requireDb();
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (opts.queueId) {
      conditions.push("queue_id = ?");
      params.push(opts.queueId);
    }

    const statuses = normalizeArray(opts.status);
    if (statuses && statuses.length > 0) {
      conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }

    const priorities = normalizeArray(opts.priority);
    if (priorities && priorities.length > 0) {
      conditions.push(`priority IN (${priorities.map(() => "?").join(", ")})`);
      params.push(...priorities);
    }

    if (opts.createdAfter) {
      conditions.push("created_at >= ?");
      params.push(opts.createdAfter);
    }

    if (opts.createdBefore) {
      conditions.push("created_at <= ?");
      params.push(opts.createdBefore);
    }

    if (opts.workstream) {
      conditions.push("workstream = ?");
      params.push(opts.workstream);
    }

    if (opts.parentItemId) {
      conditions.push("parent_item_id = ?");
      params.push(opts.parentItemId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const orderBy = opts.orderBy ?? "createdAt";
    const orderDir = opts.orderDir ?? "asc";
    const orderClause = (() => {
      if (orderBy === "priority") {
        return `ORDER BY CASE priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END ${orderDir.toUpperCase()}, created_at ${orderDir.toUpperCase()}`;
      }
      const column = orderBy === "updatedAt" ? "updated_at" : "created_at";
      return `ORDER BY ${column} ${orderDir.toUpperCase()}`;
    })();

    const limitClause = opts.limit ? "LIMIT ?" : "";
    const offsetClause = opts.offset ? "OFFSET ?" : "";
    const query = `SELECT * FROM work_items ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`;

    const queryParams = [...params];
    if (opts.limit) {
      queryParams.push(opts.limit);
    }
    if (opts.offset) {
      queryParams.push(opts.offset);
    }

    const rows = db.prepare(query).all(...queryParams);
    const items = (rows as any[]).map((row) => this.mapItem(row));

    return items
      .filter((item) => (opts.assignedTo ? item.assignedTo?.agentId === opts.assignedTo : true))
      .filter((item) => (opts.createdBy ? item.createdBy?.agentId === opts.createdBy : true))
      .filter((item) => matchesTags(item.tags, opts.tags));
  }

  async updateItem(itemId: string, patch: WorkItemPatch): Promise<WorkItem> {
    const db = this.requireDb();
    const current = await this.getItem(itemId);
    if (!current) {
      throw new Error(`Work item not found: ${itemId}`);
    }

    const updates: string[] = [];
    const params: Array<string | number | null> = [];
    const now = new Date().toISOString();

    const apply = (field: string, value: unknown) => {
      updates.push(`${field} = ?`);
      params.push(value as string | number | null);
    };

    // Use Object.hasOwn so that explicitly passing `undefined` (to clear a field)
    // is distinguished from omitting the key entirely (no change).
    const has = (key: string) => Object.hasOwn(patch, key);
    if (has("queueId")) apply("queue_id", patch.queueId);
    if (has("title")) apply("title", patch.title);
    if (has("description")) apply("description", patch.description ?? null);
    if (has("payload")) apply("payload_json", encodeJson(patch.payload));
    if (has("status")) apply("status", patch.status);
    if (has("statusReason")) apply("status_reason", patch.statusReason ?? null);
    if (has("parentItemId")) apply("parent_item_id", patch.parentItemId ?? null);
    if (has("dependsOn")) apply("depends_on_json", encodeJson(patch.dependsOn));
    if (has("blockedBy")) apply("blocked_by_json", encodeJson(patch.blockedBy));
    if (has("assignedTo")) apply("assigned_to_json", encodeJson(patch.assignedTo));
    if (has("priority")) apply("priority", patch.priority);
    if (has("workstream")) apply("workstream", patch.workstream ?? null);
    if (has("tags")) apply("tags_json", encodeJson(patch.tags));
    if (has("result")) apply("result_json", encodeJson(patch.result));
    if (has("error")) apply("error_json", encodeJson(patch.error));
    if (has("retryCount")) apply("retry_count", patch.retryCount ?? 0);
    if (has("maxRetries")) apply("max_retries", patch.maxRetries ?? null);
    if (has("deadline")) apply("deadline", patch.deadline ?? null);
    if (has("lastOutcome")) apply("last_outcome", patch.lastOutcome ?? null);
    if (has("startedAt")) apply("started_at", patch.startedAt ?? null);
    if (has("completedAt")) apply("completed_at", patch.completedAt ?? null);

    apply("updated_at", now);

    if (updates.length === 0) {
      return current;
    }

    const sql = `UPDATE work_items SET ${updates.join(", ")} WHERE id = ?`;
    db.prepare(sql).run(...params, itemId);

    const updated = await this.getItem(itemId);
    if (!updated) {
      throw new Error(`Work item not found after update: ${itemId}`);
    }
    return updated;
  }

  async deleteItem(itemId: string): Promise<boolean> {
    const db = this.requireDb();
    const res = db.prepare("DELETE FROM work_items WHERE id = ?").run(itemId);
    return res.changes > 0;
  }

  async claimNextItem(
    queueId: string,
    assignTo: { sessionKey?: string; agentId?: string },
    opts?: { workstream?: string },
  ): Promise<WorkItem | null> {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const queue = await this.getQueue(queueId);
      if (!queue) {
        db.exec("ROLLBACK");
        return null;
      }
      const inProgressRow = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM work_items WHERE queue_id = ? AND status = 'in_progress'",
        )
        .get(queueId) as { cnt: number } | undefined;
      if ((inProgressRow?.cnt ?? 0) >= queue.concurrencyLimit) {
        db.exec("ROLLBACK");
        return null;
      }

      // Build the claim query with DAG enforcement and optional workstream filter.
      // Items whose dependsOn contains any non-completed items are skipped.
      const wsFilter = opts?.workstream;
      const now = new Date().toISOString();
      const row = db
        .prepare(
          `
          SELECT wi.id FROM work_items wi
          WHERE wi.queue_id = ? AND wi.status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM json_each(wi.depends_on_json) AS dep
              JOIN work_items dep_item ON dep_item.id = dep.value
              WHERE dep_item.status != 'completed'
            )
            AND (wi.max_retries IS NULL OR wi.retry_count < wi.max_retries)
            AND (wi.deadline IS NULL OR wi.deadline > ?)
            AND (wi.workstream = ? OR ? IS NULL)
          ORDER BY
            CASE wi.priority
              WHEN 'critical' THEN 0
              WHEN 'high' THEN 1
              WHEN 'medium' THEN 2
              WHEN 'low' THEN 3
            END,
            wi.created_at ASC
          LIMIT 1
        `,
        )
        .get(queueId, now, wsFilter ?? null, wsFilter ?? null) as { id: string } | undefined;
      if (!row) {
        db.exec("ROLLBACK");
        return null;
      }

      db.prepare(
        `
        UPDATE work_items
        SET status = 'in_progress',
            assigned_to_json = ?,
            started_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      ).run(encodeJson(assignTo), now, now, row.id);

      db.exec("COMMIT");
      return await this.getItem(row.id);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async getQueueStats(queueId: string): Promise<WorkQueueStats> {
    const db = this.requireDb();
    const rows = db
      .prepare(
        `
        SELECT status, COUNT(*) as cnt
        FROM work_items
        WHERE queue_id = ?
        GROUP BY status
      `,
      )
      .all(queueId) as Array<{ status: WorkItemStatus; cnt: number }>;

    const stats: WorkQueueStats = {
      pending: 0,
      inProgress: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: 0,
    };

    for (const row of rows) {
      if (row.status === "pending") {
        stats.pending = row.cnt;
      } else if (row.status === "in_progress") {
        stats.inProgress = row.cnt;
      } else if (row.status === "blocked") {
        stats.blocked = row.cnt;
      } else if (row.status === "completed") {
        stats.completed = row.cnt;
      } else if (row.status === "failed") {
        stats.failed = row.cnt;
      } else if (row.status === "cancelled") {
        stats.cancelled = row.cnt;
      }
      stats.total += row.cnt;
    }

    return stats;
  }

  async recordExecution(exec: Omit<WorkItemExecution, "id">): Promise<WorkItemExecution> {
    const db = this.requireDb();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO work_item_executions
        (id, item_id, attempt_number, session_key, outcome, error, started_at, completed_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      exec.itemId,
      exec.attemptNumber,
      exec.sessionKey,
      exec.outcome,
      exec.error ?? null,
      exec.startedAt,
      exec.completedAt,
      exec.durationMs,
    );
    return { ...exec, id };
  }

  async listExecutions(itemId: string, opts?: { limit?: number }): Promise<WorkItemExecution[]> {
    const db = this.requireDb();
    const limit = opts?.limit ?? 50;
    const rows = db
      .prepare(
        `SELECT * FROM work_item_executions
         WHERE item_id = ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(itemId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      itemId: row.item_id as string,
      attemptNumber: row.attempt_number as number,
      sessionKey: row.session_key as string,
      outcome: row.outcome as WorkItemOutcome,
      error: (row.error as string) ?? undefined,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string,
      durationMs: row.duration_ms as number,
    }));
  }

  async storeTranscript(params: {
    itemId: string;
    executionId?: string;
    sessionKey: string;
    transcript: unknown[];
  }): Promise<string> {
    const db = this.requireDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO work_item_transcripts
        (id, item_id, execution_id, session_key, transcript_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      params.itemId,
      params.executionId ?? null,
      params.sessionKey,
      JSON.stringify(params.transcript),
      now,
    );
    return id;
  }

  async getTranscript(
    transcriptId: string,
  ): Promise<{ id: string; transcript: unknown[]; sessionKey: string; createdAt: string } | null> {
    const db = this.requireDb();
    const row = db.prepare("SELECT * FROM work_item_transcripts WHERE id = ?").get(transcriptId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      transcript: JSON.parse(row.transcript_json as string) as unknown[],
      sessionKey: row.session_key as string,
      createdAt: row.created_at as string,
    };
  }

  async listTranscripts(
    itemId: string,
  ): Promise<Array<{ id: string; executionId?: string; sessionKey: string; createdAt: string }>> {
    const db = this.requireDb();
    const rows = db
      .prepare(
        `SELECT id, execution_id, session_key, created_at
         FROM work_item_transcripts
         WHERE item_id = ?
         ORDER BY created_at DESC`,
      )
      .all(itemId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      executionId: (row.execution_id as string) ?? undefined,
      sessionKey: row.session_key as string,
      createdAt: row.created_at as string,
    }));
  }
}
