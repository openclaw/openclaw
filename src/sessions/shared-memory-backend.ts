/**
 * Shared Memory Backend
 *
 * SQLite-based persistent storage for parallel session memories.
 * Enables sessions to share knowledge while maintaining channel-scoped context.
 * Uses the built-in node:sqlite module (Node 22+).
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../memory/sqlite.js";
import type {
  SessionMemoryEntry,
  GlobalKnowledgeEntry,
  SessionState,
  WorkItem,
} from "./parallel-session-manager.js";

export interface SharedMemoryConfig {
  dbPath: string;
  enableWAL?: boolean;
  vacuumOnStartup?: boolean;
}

const SCHEMA_VERSION = 1;

/**
 * SQLite-backed shared memory for parallel sessions
 */
export class SharedMemoryBackend {
  private db: DatabaseSync | null = null;
  private config: SharedMemoryConfig;
  private initialized = false;

  constructor(config: SharedMemoryConfig) {
    this.config = config;
  }

  /**
   * Initialize the database connection and schema
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const { DatabaseSync } = requireNodeSqlite();

    // Ensure directory exists
    const dir = dirname(this.config.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.config.dbPath);

    // Enable WAL mode for better concurrent access
    if (this.config.enableWAL !== false) {
      this.db.exec("PRAGMA journal_mode = WAL");
    }

    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        memory_type TEXT NOT NULL CHECK (memory_type IN ('decision', 'preference', 'summary', 'fact', 'action')),
        content TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 5 CHECK (importance >= 1 AND importance <= 10),
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        promoted_to_global INTEGER NOT NULL DEFAULT 0,
        embedding_id TEXT
      )
    `);

    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_channel_memory_session ON channel_memory(session_key)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_channel_memory_channel ON channel_memory(channel_id)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_channel_memory_type ON channel_memory(memory_type)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_channel_memory_importance ON channel_memory(importance DESC)",
    );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        source_channel TEXT NOT NULL,
        source_session_key TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        embedding_id TEXT
      )
    `);

    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_global_knowledge_category ON global_knowledge(category)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_global_knowledge_confidence ON global_knowledge(confidence DESC)",
    );

    // work_items table — replaces the old unused action_items table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT,
        channel_id TEXT,
        description TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'scheduled'
          CHECK (status IN ('scheduled', 'ready', 'executing', 'completed', 'failed', 'cancelled')),
        priority INTEGER NOT NULL DEFAULT 5
          CHECK (priority >= 1 AND priority <= 10),
        scheduled_for INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        progress_pct INTEGER DEFAULT 0,
        result_summary TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3
      )
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_work_items_session ON work_items(session_key)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_work_items_scheduled ON work_items(status, scheduled_for)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_work_items_priority ON work_items(status, priority DESC)",
    );

    // Drop orphaned action_items table if it exists from a previous schema
    this.db.exec("DROP TABLE IF EXISTS action_items");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS person_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_id TEXT NOT NULL UNIQUE,
        display_name TEXT,
        relationship TEXT,
        notes TEXT,
        preferences TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        channel_ids TEXT
      )
    `);

    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_person_context_name ON person_context(display_name)",
    );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      )
    `);

    // Insert schema version if table is empty
    const row = this.db.prepare("SELECT COUNT(*) as c FROM schema_version").get() as
      | { c: number }
      | undefined;
    if (!row || row.c === 0) {
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    }

    // Session state table for hibernation persistence
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        session_key TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        chat_id TEXT,
        peer_id TEXT,
        status TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        context_json TEXT,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      )
    `);

    if (this.config.vacuumOnStartup) {
      this.db.exec("VACUUM");
    }

    this.initialized = true;
  }

  /**
   * Save a channel memory entry
   */
  async saveChannelMemory(entry: Omit<SessionMemoryEntry, "id">): Promise<number> {
    this.ensureInitialized();

    const result = this.db!.prepare(`
      INSERT INTO channel_memory
        (session_key, channel_id, memory_type, content, importance, created_at, expires_at, promoted_to_global)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.sessionKey,
      entry.channelId,
      entry.memoryType,
      entry.content,
      entry.importance,
      entry.createdAt,
      entry.expiresAt ?? null,
      entry.promotedToGlobal ? 1 : 0,
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Get channel memories with optional filters
   */
  async getChannelMemories(params: {
    sessionKey?: string;
    channelId?: string;
    types?: string[];
    minImportance?: number;
    excludeExpired?: boolean;
    limit?: number;
  }): Promise<SessionMemoryEntry[]> {
    this.ensureInitialized();

    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (params.sessionKey) {
      conditions.push(
        "(session_key = ? OR channel_id = (SELECT channel_id FROM channel_memory WHERE session_key = ? LIMIT 1))",
      );
      values.push(params.sessionKey, params.sessionKey);
    }

    if (params.channelId) {
      conditions.push("channel_id = ?");
      values.push(params.channelId);
    }

    if (params.types && params.types.length > 0) {
      conditions.push(`memory_type IN (${params.types.map(() => "?").join(",")})`);
      values.push(...params.types);
    }

    if (params.minImportance) {
      conditions.push("importance >= ?");
      values.push(params.minImportance);
    }

    if (params.excludeExpired !== false) {
      conditions.push("(expires_at IS NULL OR expires_at > ?)");
      values.push(Date.now());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit ?? 50;

    const rows = this.db!.prepare(`
      SELECT * FROM channel_memory ${where}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(...values, limit) as Array<{
      id: number;
      session_key: string;
      channel_id: string;
      memory_type: string;
      content: string;
      importance: number;
      created_at: number;
      expires_at: number | null;
      promoted_to_global: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionKey: row.session_key,
      channelId: row.channel_id,
      memoryType: row.memory_type as SessionMemoryEntry["memoryType"],
      content: row.content,
      importance: row.importance,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
      promotedToGlobal: row.promoted_to_global === 1,
    }));
  }

  /**
   * Save global knowledge entry
   */
  async saveGlobalKnowledge(entry: Omit<GlobalKnowledgeEntry, "id">): Promise<number> {
    this.ensureInitialized();

    const result = this.db!.prepare(`
      INSERT INTO global_knowledge
        (category, content, source_channel, source_session_key, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.category,
      entry.content,
      entry.sourceChannel,
      entry.sourceSessionKey,
      entry.confidence,
      entry.createdAt,
      entry.updatedAt,
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Get global knowledge entries
   */
  async getGlobalKnowledge(params?: {
    category?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<GlobalKnowledgeEntry[]> {
    this.ensureInitialized();

    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (params?.category) {
      conditions.push("category = ?");
      values.push(params.category);
    }

    if (params?.minConfidence) {
      conditions.push("confidence >= ?");
      values.push(params.minConfidence);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params?.limit ?? 50;

    const rows = this.db!.prepare(`
      SELECT * FROM global_knowledge ${where}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `).all(...values, limit) as Array<{
      id: number;
      category: string;
      content: string;
      source_channel: string;
      source_session_key: string;
      confidence: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      category: row.category,
      content: row.content,
      sourceChannel: row.source_channel,
      sourceSessionKey: row.source_session_key,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Search memories using LIKE
   */
  async searchMemories(
    query: string,
    params?: {
      scope?: "channel" | "global" | "all";
      channelId?: string;
      limit?: number;
    },
  ): Promise<Array<SessionMemoryEntry | GlobalKnowledgeEntry>> {
    this.ensureInitialized();

    const results: Array<SessionMemoryEntry | GlobalKnowledgeEntry> = [];
    const limit = params?.limit ?? 20;
    const likePattern = `%${query}%`;

    if (params?.scope !== "global") {
      const channelCondition = params?.channelId ? "AND channel_id = ?" : "";
      const channelValues = params?.channelId
        ? [likePattern, params.channelId, limit]
        : [likePattern, limit];

      const rows = this.db!.prepare(`
        SELECT * FROM channel_memory
        WHERE content LIKE ? ${channelCondition}
        ORDER BY importance DESC
        LIMIT ?
      `).all(...channelValues) as Array<{
        id: number;
        session_key: string;
        channel_id: string;
        memory_type: string;
        content: string;
        importance: number;
        created_at: number;
        expires_at: number | null;
        promoted_to_global: number;
      }>;

      results.push(
        ...rows.map((row) => ({
          id: row.id,
          sessionKey: row.session_key,
          channelId: row.channel_id,
          memoryType: row.memory_type as SessionMemoryEntry["memoryType"],
          content: row.content,
          importance: row.importance,
          createdAt: row.created_at,
          expiresAt: row.expires_at ?? undefined,
          promotedToGlobal: row.promoted_to_global === 1,
        })),
      );
    }

    if (params?.scope !== "channel") {
      const rows = this.db!.prepare(`
        SELECT * FROM global_knowledge
        WHERE content LIKE ?
        ORDER BY confidence DESC
        LIMIT ?
      `).all(likePattern, limit) as Array<{
        id: number;
        category: string;
        content: string;
        source_channel: string;
        source_session_key: string;
        confidence: number;
        created_at: number;
        updated_at: number;
      }>;

      results.push(
        ...rows.map((row) => ({
          id: row.id,
          category: row.category,
          content: row.content,
          sourceChannel: row.source_channel,
          sourceSessionKey: row.source_session_key,
          confidence: row.confidence,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      );
    }

    return results;
  }

  /**
   * Save session state for hibernation persistence
   */
  async saveSessionState(session: SessionState, context?: Record<string, unknown>): Promise<void> {
    this.ensureInitialized();

    this.db!.prepare(`
      INSERT OR REPLACE INTO session_state
        (session_key, channel_id, chat_id, peer_id, status, message_count, context_json, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.sessionKey,
      session.channelId,
      session.chatId ?? null,
      session.peerId ?? null,
      session.status,
      session.messageCount,
      context ? JSON.stringify(context) : null,
      session.createdAt,
      session.lastActivityAt,
    );
  }

  /**
   * Load session state from hibernation store
   */
  async loadSessionState(
    sessionKey: string,
  ): Promise<{ session: SessionState; context?: Record<string, unknown> } | null> {
    this.ensureInitialized();

    const row = this.db!.prepare("SELECT * FROM session_state WHERE session_key = ?").get(
      sessionKey,
    ) as
      | {
          session_key: string;
          channel_id: string;
          chat_id: string | null;
          peer_id: string | null;
          status: string;
          message_count: number;
          context_json: string | null;
          created_at: number;
          last_activity_at: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const session: SessionState = {
      sessionKey: row.session_key,
      channelId: row.channel_id,
      chatId: row.chat_id ?? undefined,
      peerId: row.peer_id ?? undefined,
      status: row.status as SessionState["status"],
      messageCount: row.message_count,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
    };

    const context = row.context_json
      ? (JSON.parse(row.context_json) as Record<string, unknown>)
      : undefined;

    return { session, context };
  }

  /**
   * Delete session state (after full resume)
   */
  async deleteSessionState(sessionKey: string): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare("DELETE FROM session_state WHERE session_key = ?").run(sessionKey);
  }

  // ── Work Item CRUD ──

  /**
   * Save a work item
   */
  async saveWorkItem(item: Omit<WorkItem, "id">): Promise<number> {
    this.ensureInitialized();

    const result = this.db!.prepare(`
      INSERT INTO work_items (
        session_key, channel_id, description, payload, status, priority,
        scheduled_for, created_at, started_at, completed_at,
        progress_pct, result_summary, attempts, max_attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.sessionKey,
      item.channelId,
      item.description,
      JSON.stringify(item.payload),
      item.status,
      item.priority,
      item.scheduledFor ?? null,
      item.createdAt,
      item.startedAt ?? null,
      item.completedAt ?? null,
      item.progressPct ?? 0,
      item.resultSummary ?? null,
      item.attempts,
      item.maxAttempts,
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Get work items filtered by status and/or session
   */
  async getWorkItems(options: {
    sessionKey?: string;
    channelId?: string;
    statuses?: WorkItem["status"][];
    limit?: number;
  }): Promise<WorkItem[]> {
    this.ensureInitialized();

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.sessionKey) {
      conditions.push("session_key = ?");
      params.push(options.sessionKey);
    }
    if (options.channelId) {
      conditions.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      conditions.push(`status IN (${placeholders})`);
      params.push(...options.statuses);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const limit = options.limit ?? 20;
    params.push(limit);

    const rows = this.db!.prepare(
      `SELECT * FROM work_items ${where} ORDER BY priority DESC, created_at ASC LIMIT ?`,
    ).all(...params) as Record<string, unknown>[];

    return rows.map((row) => this.rowToWorkItem(row));
  }

  /**
   * Atomically claim work items that are ready to execute.
   *
   * Uses BEGIN IMMEDIATE transaction to prevent TOCTOU race conditions —
   * if two tick() calls overlap, the second one's transaction blocks until
   * the first commits, then sees the updated status.
   */
  async claimReadyWork(limit: number = 1): Promise<WorkItem[]> {
    this.ensureInitialized();
    const now = Date.now();

    this.db!.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db!.prepare(`
        SELECT * FROM work_items
        WHERE (status = 'ready')
           OR (status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= ?)
        ORDER BY priority DESC, created_at ASC
        LIMIT ?
      `).all(now, limit) as Record<string, unknown>[];

      for (const row of rows) {
        this.db!.prepare(
          "UPDATE work_items SET status = 'executing', started_at = ? WHERE id = ?",
        ).run(now, row.id as number);
      }

      this.db!.exec("COMMIT");
      return rows.map((row) => ({
        ...this.rowToWorkItem(row),
        status: "executing" as const,
        startedAt: now,
      }));
    } catch (err) {
      this.db!.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Transition a work item to a new status
   */
  async transitionWork(
    id: number,
    status: WorkItem["status"],
    update?: Partial<Pick<WorkItem, "progressPct" | "resultSummary" | "attempts">>,
  ): Promise<void> {
    this.ensureInitialized();

    const sets = ["status = ?"];
    const params: (string | number)[] = [status];

    if (status === "executing") {
      sets.push("started_at = ?");
      params.push(Date.now());
    }
    if (status === "completed" || status === "failed") {
      sets.push("completed_at = ?");
      params.push(Date.now());
    }
    if (update?.progressPct !== undefined) {
      sets.push("progress_pct = ?");
      params.push(update.progressPct);
    }
    if (update?.resultSummary !== undefined) {
      sets.push("result_summary = ?");
      params.push(update.resultSummary);
    }
    if (update?.attempts !== undefined) {
      sets.push("attempts = ?");
      params.push(update.attempts);
    }

    params.push(id);
    this.db!.prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /**
   * Cancel a work item (only if not already executing or completed)
   */
  async cancelWork(id: number): Promise<boolean> {
    this.ensureInitialized();

    const result = this.db!.prepare(`
      UPDATE work_items SET status = 'cancelled', completed_at = ?
      WHERE id = ? AND status IN ('scheduled', 'ready')
    `).run(Date.now(), id);

    return Number(result.changes) > 0;
  }

  /**
   * Convert a database row to a WorkItem
   */
  private rowToWorkItem(row: Record<string, unknown>): WorkItem {
    return {
      id: row.id as number,
      sessionKey: row.session_key as string,
      channelId: row.channel_id as string,
      description: row.description as string,
      payload: JSON.parse((row.payload as string) || "{}"),
      status: row.status as WorkItem["status"],
      priority: row.priority as number,
      scheduledFor: row.scheduled_for as number | undefined,
      createdAt: row.created_at as number,
      startedAt: row.started_at as number | undefined,
      completedAt: row.completed_at as number | undefined,
      progressPct: row.progress_pct as number | undefined,
      resultSummary: row.result_summary as string | undefined,
      attempts: row.attempts as number,
      maxAttempts: row.max_attempts as number,
    };
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    channelMemoryCount: number;
    globalKnowledgeCount: number;
    workItemsActive: number;
    personCount: number;
  }> {
    this.ensureInitialized();

    const channelCount = this.db!.prepare("SELECT COUNT(*) as c FROM channel_memory").get() as {
      c: number;
    };
    const globalCount = this.db!.prepare("SELECT COUNT(*) as c FROM global_knowledge").get() as {
      c: number;
    };
    const workCount = this.db!.prepare(
      "SELECT COUNT(*) as c FROM work_items WHERE status IN ('scheduled', 'ready', 'executing')",
    ).get() as { c: number };
    const personCount = this.db!.prepare("SELECT COUNT(*) as c FROM person_context").get() as {
      c: number;
    };

    return {
      channelMemoryCount: channelCount.c,
      globalKnowledgeCount: globalCount.c,
      workItemsActive: workCount.c,
      personCount: personCount.c,
    };
  }

  /**
   * Cleanup expired memories
   */
  async cleanupExpired(): Promise<number> {
    this.ensureInitialized();

    const result = this.db!.prepare(`
      DELETE FROM channel_memory
      WHERE expires_at IS NOT NULL AND expires_at < ?
    `).run(Date.now());

    return Number(result.changes);
  }

  /**
   * Close the database connection (idempotent)
   */
  async close(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Already closed — ignore
      }
      this.db = null;
      this.initialized = false;
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error("SharedMemoryBackend not initialized. Call initialize() first.");
    }
  }
}

export function createSharedMemoryBackend(config: SharedMemoryConfig): SharedMemoryBackend {
  return new SharedMemoryBackend(config);
}
