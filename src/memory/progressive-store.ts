/**
 * Progressive Memory Store — SQLite backend for structured memory entries.
 *
 * This is an ADDITIVE module that sits alongside the existing MemoryIndexManager.
 * It never modifies MEMORY.md, memory_search, or memory_get.
 *
 * Features:
 * - CRUD for categorized memory entries
 * - FTS5 full-text search
 * - Vector similarity search via sqlite-vec
 * - Deduplication (cosine similarity > threshold = merge)
 * - Token estimation per entry
 * - Auto-archive on expiry
 * - All operations are idempotent
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import type {
  MemoryCategory,
  MemoryPriority,
  MemorySource,
  ProgressiveMemoryEntry,
  ProgressiveMemoryStatus,
  MemoryStoreParams,
  MemoryStoreResult,
} from "./progressive-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { PRIORITY_ORDER, VALID_CATEGORIES, VALID_PRIORITIES } from "./progressive-types.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
import { requireNodeSqlite } from "./sqlite.js";

const log = createSubsystemLogger("progressive-memory");

/** Cosine similarity threshold for deduplication. */
const DEDUP_THRESHOLD = 0.92;

/** Approximate chars per token for estimation. */
const CHARS_PER_TOKEN = 4;

/** Default embedding dimensions (OpenAI text-embedding-3-small). */
const DEFAULT_DIMS = 1536;

/** FTS table name. */
const FTS_TABLE = "progressive_entries_fts";

/** Vector table name. */
const VEC_TABLE = "progressive_entries_vec";

// ─── Schema ──────────────────────────────────────────────────────────────────

function ensureSchema(db: DatabaseSync): { ftsAvailable: boolean; ftsError?: string } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS progressive_entries (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      tags TEXT NOT NULL DEFAULT '[]',
      related_to TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_prog_category ON progressive_entries(category);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prog_priority ON progressive_entries(priority);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prog_archived ON progressive_entries(archived);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prog_created ON progressive_entries(created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prog_expires ON progressive_entries(expires_at);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS progressive_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  let ftsAvailable = false;
  let ftsError: string | undefined;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(` +
        `content, context, tags, ` +
        `id UNINDEXED, ` +
        `category UNINDEXED, ` +
        `priority UNINDEXED` +
        `);`,
    );
    ftsAvailable = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ftsError = message;
    log.warn?.(`FTS5 not available: ${message}`);
  }

  return { ftsAvailable, ftsError };
}

function ensureVecTable(
  db: DatabaseSync,
  dims: number,
): { vecAvailable: boolean; vecError?: string } {
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(` +
        `id TEXT PRIMARY KEY, ` +
        `embedding float[${dims}]` +
        `);`,
    );
    return { vecAvailable: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn?.(`Vector table creation failed: ${message}`);
    return { vecAvailable: false, vecError: message };
  }
}

// ─── Token estimation ────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Cosine similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom < 1e-10 ? 0 : dot / denom;
}

// ─── Store class ─────────────────────────────────────────────────────────────

export type ProgressiveStoreOptions = {
  /** Path to the progressive.db file. */
  dbPath: string;
  /** Embedding dimensions (default: 1536). */
  dims?: number;
  /** Custom sqlite-vec extension path (optional). */
  vecExtensionPath?: string;
  /** Deduplication cosine similarity threshold (default: 0.92). */
  dedupThreshold?: number;
};

export type EmbedFn = (text: string) => Promise<number[]>;

export class ProgressiveMemoryStore {
  private db: DatabaseSync;
  private dbPath: string;
  private dims: number;
  private dedupThreshold: number;
  private ftsAvailable = false;
  private vecAvailable = false;
  private closed = false;

  constructor(options: ProgressiveStoreOptions) {
    this.dbPath = options.dbPath;
    this.dims = options.dims ?? DEFAULT_DIMS;
    this.dedupThreshold = options.dedupThreshold ?? DEDUP_THRESHOLD;

    // Ensure parent directory exists
    const dir = path.dirname(this.dbPath);
    try {
      fsSync.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }

    const { DatabaseSync: DB } = requireNodeSqlite();
    this.db = new DB(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");

    const { ftsAvailable } = ensureSchema(this.db);
    this.ftsAvailable = ftsAvailable;
  }

  /** Load sqlite-vec extension for vector search. Must be called after construction. */
  async initVector(extensionPath?: string): Promise<void> {
    const result = await loadSqliteVecExtension({
      db: this.db,
      extensionPath,
    });
    if (result.ok) {
      const { vecAvailable } = ensureVecTable(this.db, this.dims);
      this.vecAvailable = vecAvailable;
      if (vecAvailable) {
        log.info?.(`Vector search enabled (dims=${this.dims})`);
      }
    } else {
      log.warn?.(`sqlite-vec load failed: ${result.error}`);
    }
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Store a memory entry. Checks for duplicates if an embed function is provided.
   *
   * @returns Store result with dedup info.
   */
  async store(params: MemoryStoreParams, embedFn?: EmbedFn): Promise<MemoryStoreResult> {
    this.assertOpen();
    this.validateStoreParams(params);

    const now = new Date().toISOString();
    const tokenEstimate = estimateTokens(params.content + (params.context ?? ""));
    const priority = params.priority ?? "medium";
    const tags = params.tags ?? [];
    const relatedTo = params.relatedTo ?? [];
    const source = params.source ?? "manual";

    // Check for duplicates via embedding if available
    let embedding: number[] | undefined;
    if (embedFn) {
      try {
        embedding = await embedFn(params.content);
      } catch (err) {
        log.warn?.(`Embedding failed during store, skipping dedup: ${err}`);
      }
    }

    if (embedding && this.vecAvailable) {
      const duplicate = this.findDuplicate(embedding, params.category);
      if (duplicate) {
        // Merge: update the existing entry with the new content if it's meaningfully different
        this.updateEntry(duplicate.id, {
          content: params.content,
          context: params.context,
          priority: this.higherPriority(duplicate.priority as MemoryPriority, priority),
          tags: this.mergeTags(JSON.parse(duplicate.tags as string) as string[], tags),
          relatedTo: this.mergeRelated(
            JSON.parse(duplicate.related_to as string) as string[],
            relatedTo,
          ),
          tokenEstimate,
          updatedAt: now,
        });

        // Update vector
        this.upsertVector(duplicate.id, embedding);

        this.setMeta("last_store", now);
        return {
          id: duplicate.id,
          category: params.category,
          stored: true,
          deduplicated: true,
          mergedWithId: duplicate.id,
          tokenCost: tokenEstimate,
        };
      }
    }

    // Insert new entry
    const id = randomUUID();

    const stmt = this.db.prepare(
      `INSERT INTO progressive_entries
        (id, category, content, context, priority, tags, related_to, source,
         created_at, updated_at, expires_at, token_estimate, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    stmt.run(
      id,
      params.category,
      params.content,
      params.context ?? null,
      priority,
      JSON.stringify(tags),
      JSON.stringify(relatedTo),
      source,
      now,
      now,
      params.expires ?? null,
      tokenEstimate,
    );

    // Index in FTS
    if (this.ftsAvailable) {
      try {
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (id, content, context, tags, category, priority)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            params.content,
            params.context ?? "",
            JSON.stringify(tags),
            params.category,
            priority,
          );
      } catch (err) {
        log.warn?.(`FTS insert failed: ${err}`);
      }
    }

    // Index vector
    if (embedding && this.vecAvailable) {
      this.upsertVector(id, embedding);
    }

    this.setMeta("last_store", now);
    return {
      id,
      category: params.category,
      stored: true,
      deduplicated: false,
      tokenCost: tokenEstimate,
    };
  }

  /**
   * Retrieve a single entry by ID.
   */
  getById(id: string): ProgressiveMemoryEntry | null {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM progressive_entries WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  /**
   * List entries with optional filters.
   */
  list(filters?: {
    categories?: MemoryCategory[];
    priorityMin?: MemoryPriority;
    archived?: boolean;
    limit?: number;
    offset?: number;
  }): ProgressiveMemoryEntry[] {
    this.assertOpen();
    const conditions: string[] = [];
    const binds: unknown[] = [];

    if (filters?.categories?.length) {
      const placeholders = filters.categories.map(() => "?").join(", ");
      conditions.push(`category IN (${placeholders})`);
      binds.push(...filters.categories);
    }

    if (filters?.priorityMin) {
      const minOrder = PRIORITY_ORDER[filters.priorityMin];
      const validPriorities = (Object.keys(PRIORITY_ORDER) as MemoryPriority[]).filter(
        (p) => PRIORITY_ORDER[p] >= minOrder,
      );
      const placeholders = validPriorities.map(() => "?").join(", ");
      conditions.push(`priority IN (${placeholders})`);
      binds.push(...validPriorities);
    }

    if (filters?.archived !== undefined) {
      conditions.push("archived = ?");
      binds.push(filters.archived ? 1 : 0);
    } else {
      conditions.push("archived = 0");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT * FROM progressive_entries ${where}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...binds, limit, offset) as Record<string, unknown>[];

    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Full-text search using FTS5.
   */
  searchFts(
    query: string,
    opts?: { categories?: MemoryCategory[]; limit?: number },
  ): Array<ProgressiveMemoryEntry & { score: number }> {
    this.assertOpen();
    if (!this.ftsAvailable) return [];

    const ftsQuery = buildProgressiveFtsQuery(query);
    if (!ftsQuery) return [];

    const limit = opts?.limit ?? 20;

    try {
      let sql = `
        SELECT e.*, -f.rank as score
        FROM ${FTS_TABLE} f
        JOIN progressive_entries e ON e.id = f.id
        WHERE ${FTS_TABLE} MATCH ? AND e.archived = 0
      `;
      const binds: unknown[] = [ftsQuery];

      if (opts?.categories?.length) {
        const placeholders = opts.categories.map(() => "?").join(", ");
        sql += ` AND e.category IN (${placeholders})`;
        binds.push(...opts.categories);
      }

      sql += ` ORDER BY score DESC LIMIT ?`;
      binds.push(limit);

      const rows = this.db.prepare(sql).all(...binds) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        ...this.rowToEntry(row),
        score: (row.score as number) ?? 0,
      }));
    } catch (err) {
      log.warn?.(`FTS search failed: ${err}`);
      return [];
    }
  }

  /**
   * Vector similarity search.
   */
  searchVector(
    embedding: number[],
    opts?: { categories?: MemoryCategory[]; limit?: number },
  ): Array<ProgressiveMemoryEntry & { score: number }> {
    this.assertOpen();
    if (!this.vecAvailable) return [];

    const limit = opts?.limit ?? 20;

    try {
      const vecBlob = new Float32Array(embedding);
      const rows = this.db
        .prepare(
          `SELECT v.id, v.distance
           FROM ${VEC_TABLE} v
           WHERE v.embedding MATCH ?
           ORDER BY v.distance ASC
           LIMIT ?`,
        )
        .all(vecBlob, limit * 2) as Array<{ id: string; distance: number }>;

      // Join with entry data and filter
      const results: Array<ProgressiveMemoryEntry & { score: number }> = [];
      for (const row of rows) {
        const entry = this.getById(row.id);
        if (!entry || entry.archived) continue;
        if (opts?.categories?.length && !opts.categories.includes(entry.category)) {
          continue;
        }
        results.push({
          ...entry,
          score: 1 - row.distance, // Convert distance to similarity
        });
        if (results.length >= limit) break;
      }

      return results;
    } catch (err) {
      log.warn?.(`Vector search failed: ${err}`);
      return [];
    }
  }

  /**
   * Hybrid search combining FTS and vector results.
   */
  async searchHybrid(
    query: string,
    embedding: number[] | undefined,
    opts?: {
      categories?: MemoryCategory[];
      priorityMin?: MemoryPriority;
      limit?: number;
      vectorWeight?: number;
      textWeight?: number;
    },
  ): Promise<Array<ProgressiveMemoryEntry & { score: number }>> {
    const limit = opts?.limit ?? 20;
    const vectorWeight = opts?.vectorWeight ?? 0.7;
    const textWeight = opts?.textWeight ?? 0.3;

    const ftsResults = this.searchFts(query, { categories: opts?.categories, limit: limit * 2 });
    const vecResults = embedding
      ? this.searchVector(embedding, { categories: opts?.categories, limit: limit * 2 })
      : [];

    // Merge by ID
    const byId = new Map<string, ProgressiveMemoryEntry & { vecScore: number; ftsScore: number }>();

    for (const r of vecResults) {
      byId.set(r.id, { ...r, vecScore: r.score, ftsScore: 0 });
    }

    for (const r of ftsResults) {
      const existing = byId.get(r.id);
      if (existing) {
        existing.ftsScore = r.score;
      } else {
        byId.set(r.id, { ...r, vecScore: 0, ftsScore: r.score });
      }
    }

    let merged = Array.from(byId.values())
      .map((entry) => ({
        ...entry,
        score: vectorWeight * entry.vecScore + textWeight * entry.ftsScore,
      }))
      .sort((a, b) => b.score - a.score);

    // Filter by priority if specified
    if (opts?.priorityMin) {
      const minOrder = PRIORITY_ORDER[opts.priorityMin];
      merged = merged.filter((e) => PRIORITY_ORDER[e.priority] >= minOrder);
    }

    return merged.slice(0, limit);
  }

  /**
   * Archive an entry (soft delete).
   */
  archive(id: string): boolean {
    this.assertOpen();
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE progressive_entries SET archived = 1, updated_at = ? WHERE id = ?")
      .run(now, id);
    return (result.changes ?? 0) > 0;
  }

  /**
   * Delete an entry permanently.
   */
  delete(id: string): boolean {
    this.assertOpen();
    // Remove from FTS
    if (this.ftsAvailable) {
      try {
        this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE id = ?`).run(id);
      } catch {
        // ignore
      }
    }
    // Remove from vector table
    if (this.vecAvailable) {
      try {
        this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE id = ?`).run(id);
      } catch {
        // ignore
      }
    }
    const result = this.db.prepare("DELETE FROM progressive_entries WHERE id = ?").run(id);
    return (result.changes ?? 0) > 0;
  }

  /**
   * Archive all entries that have passed their expiry date.
   */
  archiveExpired(): number {
    this.assertOpen();
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE progressive_entries
         SET archived = 1, updated_at = ?
         WHERE expires_at IS NOT NULL AND expires_at < ? AND archived = 0`,
      )
      .run(now, now);
    const count = result.changes ?? 0;
    if (count > 0) {
      log.info?.(`Archived ${count} expired entries`);
    }
    return count;
  }

  // ─── Status / metadata ─────────────────────────────────────────────────

  /**
   * Get progressive memory system status.
   */
  status(): ProgressiveMemoryStatus {
    this.assertOpen();

    const totalRow = this.db
      .prepare("SELECT COUNT(*) as count FROM progressive_entries WHERE archived = 0")
      .get() as { count: number };

    const categoryRows = this.db
      .prepare(
        "SELECT category, COUNT(*) as count FROM progressive_entries WHERE archived = 0 GROUP BY category",
      )
      .all() as Array<{ category: string; count: number }>;

    const priorityRows = this.db
      .prepare(
        "SELECT priority, COUNT(*) as count FROM progressive_entries WHERE archived = 0 GROUP BY priority",
      )
      .all() as Array<{ priority: string; count: number }>;

    const tokenRow = this.db
      .prepare(
        "SELECT COALESCE(SUM(token_estimate), 0) as total FROM progressive_entries WHERE archived = 0",
      )
      .get() as { total: number };

    const byCategory = Object.fromEntries(categoryRows.map((r) => [r.category, r.count])) as Record<
      MemoryCategory,
      number
    >;

    const byPriority = Object.fromEntries(priorityRows.map((r) => [r.priority, r.count])) as Record<
      MemoryPriority,
      number
    >;

    return {
      totalEntries: totalRow.count,
      byCategory,
      byPriority,
      totalTokensEstimated: tokenRow.total,
      lastStore: this.getMeta("last_store") ?? undefined,
      lastRecall: this.getMeta("last_recall") ?? undefined,
      domainFiles: [],
      dbPath: this.dbPath,
      vectorEnabled: this.vecAvailable,
      ftsEnabled: this.ftsAvailable,
    };
  }

  get isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  get isVecAvailable(): boolean {
    return this.vecAvailable;
  }

  // ─── Close ─────────────────────────────────────────────────────────────

  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.db.close();
      } catch {
        // ignore
      }
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("ProgressiveMemoryStore is closed");
    }
  }

  private validateStoreParams(params: MemoryStoreParams): void {
    if (!VALID_CATEGORIES.has(params.category)) {
      throw new Error(
        `Invalid category: ${params.category}. Must be one of: ${[...VALID_CATEGORIES].join(", ")}`,
      );
    }
    if (!params.content?.trim()) {
      throw new Error("Content is required and cannot be empty");
    }
    if (params.priority && !VALID_PRIORITIES.has(params.priority)) {
      throw new Error(
        `Invalid priority: ${params.priority}. Must be one of: ${[...VALID_PRIORITIES].join(", ")}`,
      );
    }
    if (params.expires) {
      const date = new Date(params.expires);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid expires date: ${params.expires}`);
      }
    }
  }

  private findDuplicate(
    embedding: number[],
    category: MemoryCategory,
  ): Record<string, unknown> | null {
    if (!this.vecAvailable) return null;

    try {
      const vecBlob = new Float32Array(embedding);
      const candidates = this.db
        .prepare(
          `SELECT v.id, v.distance
           FROM ${VEC_TABLE} v
           WHERE v.embedding MATCH ?
           ORDER BY v.distance ASC
           LIMIT 5`,
        )
        .all(vecBlob) as Array<{ id: string; distance: number }>;

      for (const candidate of candidates) {
        const similarity = 1 - candidate.distance;
        if (similarity >= this.dedupThreshold) {
          const entry = this.db
            .prepare(
              "SELECT * FROM progressive_entries WHERE id = ? AND category = ? AND archived = 0",
            )
            .get(candidate.id, category) as Record<string, unknown> | undefined;
          if (entry) {
            return entry;
          }
        }
      }
    } catch (err) {
      log.warn?.(`Dedup check failed: ${err}`);
    }

    return null;
  }

  private updateEntry(
    id: string,
    updates: {
      content?: string;
      context?: string;
      priority?: MemoryPriority;
      tags?: string[];
      relatedTo?: string[];
      tokenEstimate?: number;
      updatedAt: string;
    },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const binds: unknown[] = [updates.updatedAt];

    if (updates.content !== undefined) {
      sets.push("content = ?");
      binds.push(updates.content);
    }
    if (updates.context !== undefined) {
      sets.push("context = ?");
      binds.push(updates.context);
    }
    if (updates.priority !== undefined) {
      sets.push("priority = ?");
      binds.push(updates.priority);
    }
    if (updates.tags !== undefined) {
      sets.push("tags = ?");
      binds.push(JSON.stringify(updates.tags));
    }
    if (updates.relatedTo !== undefined) {
      sets.push("related_to = ?");
      binds.push(JSON.stringify(updates.relatedTo));
    }
    if (updates.tokenEstimate !== undefined) {
      sets.push("token_estimate = ?");
      binds.push(updates.tokenEstimate);
    }

    binds.push(id);
    this.db.prepare(`UPDATE progressive_entries SET ${sets.join(", ")} WHERE id = ?`).run(...binds);

    // Update FTS
    if (this.ftsAvailable && updates.content !== undefined) {
      try {
        this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE id = ?`).run(id);
        const entry = this.db
          .prepare("SELECT * FROM progressive_entries WHERE id = ?")
          .get(id) as Record<string, unknown>;
        if (entry) {
          this.db
            .prepare(
              `INSERT INTO ${FTS_TABLE} (id, content, context, tags, category, priority)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              entry.content,
              entry.context ?? "",
              entry.tags,
              entry.category,
              entry.priority,
            );
        }
      } catch (err) {
        log.warn?.(`FTS update failed: ${err}`);
      }
    }
  }

  private upsertVector(id: string, embedding: number[]): void {
    if (!this.vecAvailable) return;
    try {
      // Delete then insert (upsert pattern for vec0)
      this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE id = ?`).run(id);
      const vecBlob = new Float32Array(embedding);
      this.db.prepare(`INSERT INTO ${VEC_TABLE} (id, embedding) VALUES (?, ?)`).run(id, vecBlob);
    } catch (err) {
      log.warn?.(`Vector upsert failed: ${err}`);
    }
  }

  private higherPriority(a: MemoryPriority, b: MemoryPriority): MemoryPriority {
    return PRIORITY_ORDER[a] >= PRIORITY_ORDER[b] ? a : b;
  }

  private mergeTags(existing: string[], incoming: string[]): string[] {
    return [...new Set([...existing, ...incoming])];
  }

  private mergeRelated(existing: string[], incoming: string[]): string[] {
    return [...new Set([...existing, ...incoming])];
  }

  private setMeta(key: string, value: string): void {
    try {
      this.db
        .prepare(`INSERT OR REPLACE INTO progressive_meta (key, value) VALUES (?, ?)`)
        .run(key, value);
    } catch {
      // non-critical
    }
  }

  private getMeta(key: string): string | null {
    try {
      const row = this.db.prepare("SELECT value FROM progressive_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private rowToEntry(row: Record<string, unknown>): ProgressiveMemoryEntry {
    return {
      id: row.id as string,
      category: row.category as MemoryCategory,
      content: row.content as string,
      context: (row.context as string) ?? undefined,
      priority: row.priority as MemoryPriority,
      tags: safeParseJsonArray(row.tags as string),
      relatedTo: safeParseJsonArray(row.related_to as string),
      source: row.source as MemorySource,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      expiresAt: (row.expires_at as string) ?? undefined,
      tokenEstimate: row.token_estimate as number,
      archived: (row.archived as number) === 1,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildProgressiveFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}
