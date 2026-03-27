import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireNodeSqlite } from "../../../packages/memory-host-sdk/src/host/sqlite.js";
import type { Episode, EpisodeAssociation } from "./types.js";

const log = createSubsystemLogger("memory");

export class EpisodicStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id                  TEXT PRIMARY KEY,
        agent_id            TEXT NOT NULL,
        session_key         TEXT,
        created_at          TEXT NOT NULL,
        summary             TEXT NOT NULL,
        details             TEXT,
        participants        TEXT,
        importance          REAL DEFAULT 0.5,
        emotional_valence   REAL DEFAULT 0.0,
        emotional_arousal   REAL DEFAULT 0.0,
        topic_tags          TEXT,
        linked_episodes     TEXT,
        context_hash        TEXT,
        consolidation_status TEXT DEFAULT 'raw',
        consolidation_count  INTEGER DEFAULT 0,
        last_accessed_at    TEXT,
        access_count        INTEGER DEFAULT 0,
        embedding           BLOB
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodes_importance ON episodes(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_episodes_consolidation ON episodes(consolidation_status);
      CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent_id);

      CREATE TABLE IF NOT EXISTS episode_associations (
        episode_id    TEXT NOT NULL,
        associated_id TEXT NOT NULL,
        strength      REAL DEFAULT 1.0,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (episode_id, associated_id)
      );

      -- Sentinel table used for atomic deduplication of compaction passes.
      -- Each row represents a unique (agent, session, content-hash) batch that
      -- has already been encoded.  The UNIQUE constraint plus INSERT OR IGNORE
      -- makes the check-then-claim atomic at the SQLite level, preventing
      -- duplicate episodes from fire-and-forget concurrent compaction calls.
      CREATE TABLE IF NOT EXISTS episodic_compaction_hashes (
        agent_id     TEXT NOT NULL,
        session_key  TEXT NOT NULL,
        context_hash TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        UNIQUE (agent_id, session_key, context_hash)
      );
    `);
  }

  create(
    episode: Omit<Episode, "id" | "access_count" | "consolidation_count" | "consolidation_status"> &
      Partial<
        Pick<Episode, "id" | "access_count" | "consolidation_count" | "consolidation_status">
      >,
  ): Episode {
    const id = episode.id ?? randomUUID();
    const now = new Date().toISOString();
    const created_at = episode.created_at ?? now;

    let embeddingBlob: Uint8Array | null = null;
    if (episode.embedding) {
      embeddingBlob = new Uint8Array(
        episode.embedding.buffer,
        episode.embedding.byteOffset,
        episode.embedding.byteLength,
      );
    }

    this.db
      .prepare(
        `INSERT INTO episodes (
          id, agent_id, session_key, created_at, summary, details, participants,
          importance, emotional_valence, emotional_arousal, topic_tags, linked_episodes,
          context_hash, consolidation_status, consolidation_count, last_accessed_at,
          access_count, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        episode.agent_id,
        episode.session_key ?? null,
        created_at,
        episode.summary,
        episode.details ?? null,
        episode.participants ? JSON.stringify(episode.participants) : null,
        episode.importance,
        episode.emotional_valence,
        episode.emotional_arousal,
        episode.topic_tags ? JSON.stringify(episode.topic_tags) : null,
        episode.linked_episodes ? JSON.stringify(episode.linked_episodes) : null,
        episode.context_hash ?? null,
        episode.consolidation_status ?? "raw",
        episode.consolidation_count ?? 0,
        episode.last_accessed_at ?? null,
        episode.access_count ?? 0,
        embeddingBlob,
      );

    return this.getById(id)!;
  }

  getById(id: string): Episode | null {
    const row = this.db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return null;
    }
    return this.rowToEpisode(row);
  }

  getAll(agentId?: string, status?: string): Episode[] {
    let query = "SELECT * FROM episodes";
    const params: (string | number | null)[] = [];
    const conditions: string[] = [];

    if (agentId) {
      conditions.push("agent_id = ?");
      params.push(agentId);
    }
    if (status) {
      conditions.push("consolidation_status = ?");
      params.push(status);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY created_at DESC";

    const stmt = this.db.prepare(query);
    const rows =
      params.length > 0
        ? (stmt.all(...(params as Parameters<typeof stmt.all>)) as Record<string, unknown>[])
        : (stmt.all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToEpisode(r));
  }

  getForConsolidation(agentId?: string): Episode[] {
    let query = `SELECT * FROM episodes WHERE consolidation_status IN ('raw', 'reviewed')`;
    const params: (string | number | null)[] = [];
    if (agentId) {
      query += " AND agent_id = ?";
      params.push(agentId);
    }
    query += " ORDER BY importance DESC, created_at DESC";
    const stmt = this.db.prepare(query);
    const rows =
      params.length > 0
        ? (stmt.all(...(params as Parameters<typeof stmt.all>)) as Record<string, unknown>[])
        : (stmt.all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToEpisode(r));
  }

  updateStatus(id: string, status: Episode["consolidation_status"]): void {
    this.db
      .prepare(
        `UPDATE episodes
        SET consolidation_status = ?, consolidation_count = consolidation_count + 1
        WHERE id = ?`,
      )
      .run(status, id);
  }

  recordAccess(id: string): void {
    this.db
      .prepare(
        `UPDATE episodes
        SET access_count = access_count + 1, last_accessed_at = ?
        WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  }

  upsertAssociation(episodeId: string, associatedId: string, strengthDelta: number = 0.1): void {
    const existing = this.db
      .prepare("SELECT * FROM episode_associations WHERE episode_id = ? AND associated_id = ?")
      .get(episodeId, associatedId) as Record<string, unknown> | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE episode_associations SET strength = strength + ? WHERE episode_id = ? AND associated_id = ?`,
        )
        .run(strengthDelta, episodeId, associatedId);
    } else {
      this.db
        .prepare(
          `INSERT INTO episode_associations (episode_id, associated_id, strength, created_at)
          VALUES (?, ?, 1.0, ?)`,
        )
        .run(episodeId, associatedId, new Date().toISOString());
    }
  }

  getAssociations(episodeId: string): EpisodeAssociation[] {
    const rows = this.db
      .prepare("SELECT * FROM episode_associations WHERE episode_id = ? ORDER BY strength DESC")
      .all(episodeId) as unknown as EpisodeAssociation[];
    return rows;
  }

  private rowToEpisode(row: Record<string, unknown>): Episode {
    const embeddingRaw = row["embedding"];
    let embedding: Float32Array | undefined;
    if (embeddingRaw instanceof Uint8Array) {
      embedding = new Float32Array(
        embeddingRaw.buffer,
        embeddingRaw.byteOffset,
        embeddingRaw.byteLength / 4,
      );
    }

    return {
      id: row["id"] as string,
      agent_id: row["agent_id"] as string,
      session_key: (row["session_key"] as string | null) ?? undefined,
      created_at: row["created_at"] as string,
      summary: row["summary"] as string,
      details: (row["details"] as string | null) ?? undefined,
      participants: row["participants"] ? JSON.parse(row["participants"] as string) : undefined,
      importance: row["importance"] as number,
      emotional_valence: row["emotional_valence"] as number,
      emotional_arousal: row["emotional_arousal"] as number,
      topic_tags: row["topic_tags"] ? JSON.parse(row["topic_tags"] as string) : undefined,
      linked_episodes: row["linked_episodes"]
        ? JSON.parse(row["linked_episodes"] as string)
        : undefined,
      context_hash: (row["context_hash"] as string | null) ?? undefined,
      consolidation_status: row["consolidation_status"] as Episode["consolidation_status"],
      consolidation_count: row["consolidation_count"] as number,
      last_accessed_at: (row["last_accessed_at"] as string | null) ?? undefined,
      access_count: row["access_count"] as number,
      embedding,
    };
  }

  /** Return the number of episodes already stored for a given agent + session. */
  countBySession(agentId: string, sessionKey: string): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM episodes WHERE agent_id = ? AND session_key = ?",
    );
    const row = stmt.get(agentId, sessionKey) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * Atomically claim a (agent_id, session_key, context_hash) slot in the
   * `episodic_compaction_hashes` sentinel table.
   *
   * Returns `true` if this call won the race and the caller should proceed
   * to insert episodes.  Returns `false` if another concurrent (or previous)
   * compaction pass already claimed the same hash, meaning the episodes have
   * already been stored and the caller should skip.
   *
   * Using `INSERT OR IGNORE` with the UNIQUE constraint makes the check-and-
   * claim a single atomic DB operation, which prevents the TOCTOU race that
   * a separate `hasEpisodesForContentHash` + `create` pattern would allow
   * when fire-and-forget compactions overlap.
   */
  claimContentHash(agentId: string, sessionKey: string, contextHash: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO episodic_compaction_hashes
         (agent_id, session_key, context_hash, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(agentId, sessionKey, contextHash, new Date().toISOString());
    // changes === 1 means the row was inserted (we won the race).
    // changes === 0 means IGNORE fired (another caller already claimed it).
    return (result.changes as number) === 1;
  }

  /**
   * @deprecated Use `claimContentHash` for atomic deduplication instead.
   *
   * Return true if at least one episode already exists for the given
   * agent + session + content hash combination.  This is a non-atomic read
   * and is kept only for backwards compatibility with any external callers.
   */
  hasEpisodesForContentHash(agentId: string, sessionKey: string, contextHash: string): boolean {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM episodes WHERE agent_id = ? AND session_key = ? AND context_hash = ?",
    );
    const row = stmt.get(agentId, sessionKey, contextHash) as { cnt: number } | undefined;
    return (row?.cnt ?? 0) > 0;
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      log.warn(`EpisodicStore: error closing database: ${String(err)}`);
    }
  }
}
