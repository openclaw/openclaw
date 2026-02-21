/**
 * Shared Memory Backend
 *
 * SQLite-based persistent storage for parallel session memories.
 * Enables sessions to share knowledge while maintaining channel-scoped context.
 *
 * @untested - This is a proof-of-concept implementation
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionMemoryEntry, GlobalKnowledgeEntry } from "./parallel-session-manager.js";

// Lazy-load better-sqlite3 to avoid startup overhead
let Database: typeof import("better-sqlite3") | null = null;

async function getDatabase(): Promise<typeof import("better-sqlite3")> {
  if (!Database) {
    Database = (await import("better-sqlite3")).default;
  }
  return Database;
}

export interface SharedMemoryConfig {
  dbPath: string;
  enableWAL?: boolean;
  vacuumOnStartup?: boolean;
}

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
-- Channel-scoped memories
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
);

CREATE INDEX IF NOT EXISTS idx_channel_memory_session ON channel_memory(session_key);
CREATE INDEX IF NOT EXISTS idx_channel_memory_channel ON channel_memory(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_memory_type ON channel_memory(memory_type);
CREATE INDEX IF NOT EXISTS idx_channel_memory_importance ON channel_memory(importance DESC);

-- Global knowledge base (cross-channel)
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
);

CREATE INDEX IF NOT EXISTS idx_global_knowledge_category ON global_knowledge(category);
CREATE INDEX IF NOT EXISTS idx_global_knowledge_confidence ON global_knowledge(confidence DESC);

-- Action items / follow-ups
CREATE TABLE IF NOT EXISTS action_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT,
  channel_id TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);
CREATE INDEX IF NOT EXISTS idx_action_items_channel ON action_items(channel_id);

-- Person context (cross-channel identity)
CREATE TABLE IF NOT EXISTS person_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  relationship TEXT,
  notes TEXT,
  preferences TEXT, -- JSON
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  channel_ids TEXT -- JSON array of channels
);

CREATE INDEX IF NOT EXISTS idx_person_context_name ON person_context(display_name);

-- Schema versioning
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- Insert initial version if not exists
INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_VERSION});
`;

/**
 * SQLite-backed shared memory for parallel sessions
 */
export class SharedMemoryBackend {
  private db: InstanceType<typeof import("better-sqlite3")> | null = null;
  private config: SharedMemoryConfig;
  private initialized = false;

  constructor(config: SharedMemoryConfig) {
    this.config = config;
  }

  /**
   * Initialize the database connection and schema
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const BetterSqlite3 = await getDatabase();

    // Ensure directory exists
    const dir = dirname(this.config.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new BetterSqlite3(this.config.dbPath);

    // Enable WAL mode for better concurrent access
    if (this.config.enableWAL !== false) {
      this.db.pragma("journal_mode = WAL");
    }

    // Create schema
    this.db.exec(SCHEMA_SQL);

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

    const stmt = this.db!.prepare(`
      INSERT INTO channel_memory 
        (session_key, channel_id, memory_type, content, importance, created_at, expires_at, promoted_to_global)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      entry.sessionKey,
      entry.channelId,
      entry.memoryType,
      entry.content,
      entry.importance,
      entry.createdAt,
      entry.expiresAt ?? null,
      entry.promotedToGlobal ? 1 : 0
    );

    return result.lastInsertRowid as number;
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
      conditions.push("session_key = ?");
      values.push(params.sessionKey);
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

    const stmt = this.db!.prepare(`
      SELECT * FROM channel_memory ${where}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(...values, limit) as Array<{
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

    const stmt = this.db!.prepare(`
      INSERT INTO global_knowledge 
        (category, content, source_channel, source_session_key, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      entry.category,
      entry.content,
      entry.sourceChannel,
      entry.sourceSessionKey,
      entry.confidence,
      entry.createdAt,
      entry.updatedAt
    );

    return result.lastInsertRowid as number;
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

    const stmt = this.db!.prepare(`
      SELECT * FROM global_knowledge ${where}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(...values, limit) as Array<{
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
   * Search memories using FTS (if available) or LIKE
   */
  async searchMemories(query: string, params?: {
    scope?: "channel" | "global" | "all";
    channelId?: string;
    limit?: number;
  }): Promise<Array<SessionMemoryEntry | GlobalKnowledgeEntry>> {
    this.ensureInitialized();

    const results: Array<SessionMemoryEntry | GlobalKnowledgeEntry> = [];
    const limit = params?.limit ?? 20;
    const likePattern = `%${query}%`;

    if (params?.scope !== "global") {
      const channelCondition = params?.channelId ? "AND channel_id = ?" : "";
      const channelValues = params?.channelId ? [likePattern, params.channelId, limit] : [likePattern, limit];

      const stmt = this.db!.prepare(`
        SELECT * FROM channel_memory
        WHERE content LIKE ? ${channelCondition}
        ORDER BY importance DESC
        LIMIT ?
      `);

      const rows = stmt.all(...channelValues) as Array<{
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

      results.push(...rows.map((row) => ({
        id: row.id,
        sessionKey: row.session_key,
        channelId: row.channel_id,
        memoryType: row.memory_type as SessionMemoryEntry["memoryType"],
        content: row.content,
        importance: row.importance,
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? undefined,
        promotedToGlobal: row.promoted_to_global === 1,
      })));
    }

    if (params?.scope !== "channel") {
      const stmt = this.db!.prepare(`
        SELECT * FROM global_knowledge
        WHERE content LIKE ?
        ORDER BY confidence DESC
        LIMIT ?
      `);

      const rows = stmt.all(likePattern, limit) as Array<{
        id: number;
        category: string;
        content: string;
        source_channel: string;
        source_session_key: string;
        confidence: number;
        created_at: number;
        updated_at: number;
      }>;

      results.push(...rows.map((row) => ({
        id: row.id,
        category: row.category,
        content: row.content,
        sourceChannel: row.source_channel,
        sourceSessionKey: row.source_session_key,
        confidence: row.confidence,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })));
    }

    return results;
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    channelMemoryCount: number;
    globalKnowledgeCount: number;
    actionItemsOpen: number;
    personCount: number;
  }> {
    this.ensureInitialized();

    const channelCount = this.db!.prepare("SELECT COUNT(*) as count FROM channel_memory").get() as { count: number };
    const globalCount = this.db!.prepare("SELECT COUNT(*) as count FROM global_knowledge").get() as { count: number };
    const actionsCount = this.db!.prepare("SELECT COUNT(*) as count FROM action_items WHERE status = 'open'").get() as { count: number };
    const personCount = this.db!.prepare("SELECT COUNT(*) as count FROM person_context").get() as { count: number };

    return {
      channelMemoryCount: channelCount.count,
      globalKnowledgeCount: globalCount.count,
      actionItemsOpen: actionsCount.count,
      personCount: personCount.count,
    };
  }

  /**
   * Cleanup expired memories
   */
  async cleanupExpired(): Promise<number> {
    this.ensureInitialized();

    const stmt = this.db!.prepare(`
      DELETE FROM channel_memory
      WHERE expires_at IS NOT NULL AND expires_at < ?
    `);

    const result = stmt.run(Date.now());
    return result.changes;
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
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
