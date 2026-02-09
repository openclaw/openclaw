/**
 * OpenClaw AGI - Episodic Memory
 *
 * Long-term session recording, event tracking, and episode summarization.
 * Episodes are summarized and embedded for semantic retrieval of past experiences.
 *
 * Design: Records events within sessions, chunks them into episodes,
 * and generates embeddings (via Voyage AI) for similarity search.
 *
 * Uses the shared DatabaseManager — never creates its own DB connection.
 *
 * @module agi/episodic
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getDatabase, jsonToSql, sqlToJson, sqlToDate } from "../shared/db.js";

const log = createSubsystemLogger("agi:episodic");

// ============================================================================
// TYPES
// ============================================================================

export type SessionOutcome = "ongoing" | "success" | "partial" | "failure" | "abandoned";

export type EventType =
  | "user_message"
  | "agent_message"
  | "tool_call"
  | "tool_result"
  | "error"
  | "decision"
  | "milestone"
  | "context_switch"
  | "system_event";

export interface EpisodicSession {
  id: string;
  agentId: string;
  startTime: Date;
  endTime?: Date;
  intent?: string;
  outcome: SessionOutcome;
  summary?: string;
  embedding?: number[];
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  timestamp: Date;
  type: EventType;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface Episode {
  id: string;
  sessionId: string;
  startTime: Date;
  endTime: Date;
  summary: string;
  entities: string[];
  embedding?: number[];
}

export interface EpisodeSearchResult {
  episode: Episode;
  score: number;
}

export interface SessionSearchResult {
  session: EpisodicSession;
  score: number;
}

// Embedding function type — callers provide the actual embedding implementation
export type EmbedFn = (text: string) => Promise<number[]>;

// ============================================================================
// EPISODIC MEMORY MANAGER
// ============================================================================

export class EpisodicMemoryManager {
  private db: DatabaseSync;
  private agentId: string;
  private embedFn?: EmbedFn;

  constructor(agentId: string, embedFn?: EmbedFn, dbPath?: string) {
    this.agentId = agentId;
    this.db = getDatabase(agentId, dbPath);
    this.embedFn = embedFn;
    log.info(`EpisodicMemoryManager initialized for agent: ${agentId}`);
  }

  /** Set embedding function (can be deferred after construction) */
  setEmbedFn(fn: EmbedFn): void {
    this.embedFn = fn;
  }

  // ============================================================================
  // SESSION RECORDING
  // ============================================================================

  /** Start recording a new session */
  startSession(intent?: string): EpisodicSession {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO agi_sessions (id, agent_id, start_time, intent, outcome)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, this.agentId, now, intent || null, "ongoing");

    log.info(`Started episodic session: ${id}`);
    return {
      id,
      agentId: this.agentId,
      startTime: new Date(now),
      intent,
      outcome: "ongoing",
    };
  }

  /** End a session with a summary */
  async endSession(
    sessionId: string,
    outcome: SessionOutcome,
    summary?: string,
  ): Promise<EpisodicSession> {
    const now = new Date().toISOString();
    let embedding: number[] | undefined;

    // Generate embedding for the session summary if we have the function + summary
    if (summary && this.embedFn) {
      try {
        embedding = await this.embedFn(summary);
        log.debug(`Generated embedding for session summary (${embedding.length} dims)`);
      } catch (err) {
        log.warn(`Failed to embed session summary: ${String(err)}`);
      }
    }

    this.db
      .prepare(
        `UPDATE agi_sessions SET end_time = ?, outcome = ?, summary = ?, embedding = ?
       WHERE id = ?`,
      )
      .run(now, outcome, summary || null, jsonToSql(embedding), sessionId);

    log.info(`Ended session ${sessionId}: ${outcome}`);
    return {
      id: sessionId,
      agentId: this.agentId,
      startTime: new Date(), // Placeholder — caller can load full session
      endTime: new Date(now),
      intent: undefined,
      outcome,
      summary,
      embedding,
    };
  }

  /** Get a session by ID */
  getSession(sessionId: string): EpisodicSession | null {
    const row = this.db.prepare("SELECT * FROM agi_sessions WHERE id = ?").get(sessionId) as
      | Record<string, unknown>
      | undefined;

    return row ? this.rowToSession(row) : null;
  }

  /** List recent sessions */
  listSessions(limit = 20, offset = 0): EpisodicSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agi_sessions WHERE agent_id = ?
       ORDER BY start_time DESC LIMIT ? OFFSET ?`,
      )
      .all(this.agentId, limit, offset) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToSession(row));
  }

  // ============================================================================
  // EVENT RECORDING
  // ============================================================================

  /** Record an event within a session */
  recordEvent(
    sessionId: string,
    type: EventType,
    content: string,
    metadata?: Record<string, unknown>,
  ): SessionEvent {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO agi_events (id, session_id, timestamp, type, content, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, now, type, content, jsonToSql(metadata));

    log.debug(`Recorded event: ${type} in session ${sessionId}`);
    return {
      id,
      sessionId,
      timestamp: new Date(now),
      type,
      content,
      metadata,
    };
  }

  /** Get events for a session */
  getEvents(sessionId: string, limit = 100): SessionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agi_events WHERE session_id = ?
       ORDER BY timestamp ASC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      timestamp: new Date(row.timestamp as string),
      type: row.type as EventType,
      content: row.content as string,
      metadata: sqlToJson<Record<string, unknown>>(row.metadata as string | null),
    }));
  }

  /** Count events in a session */
  countEvents(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM agi_events WHERE session_id = ?")
      .get(sessionId) as { count: number };
    return row.count;
  }

  // ============================================================================
  // EPISODE MANAGEMENT
  // ============================================================================

  /**
   * Create an episode from a range of events in a session.
   *
   * Episodes are the unit of semantic retrieval — they summarize a coherent
   * chunk of agent activity and can be searched by embedding similarity.
   */
  async createEpisode(config: {
    sessionId: string;
    startTime: Date;
    endTime: Date;
    summary: string;
    entities?: string[];
  }): Promise<Episode> {
    const id = randomUUID();
    let embedding: number[] | undefined;

    if (this.embedFn) {
      try {
        embedding = await this.embedFn(config.summary);
        log.debug(`Generated embedding for episode (${embedding.length} dims)`);
      } catch (err) {
        log.warn(`Failed to embed episode: ${String(err)}`);
      }
    }

    this.db
      .prepare(
        `INSERT INTO episodes (id, session_id, start_time, end_time, summary, entities, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        config.sessionId,
        config.startTime.toISOString(),
        config.endTime.toISOString(),
        config.summary,
        jsonToSql(config.entities || []),
        jsonToSql(embedding),
      );

    log.info(`Created episode: ${id} in session ${config.sessionId}`);
    return {
      id,
      sessionId: config.sessionId,
      startTime: config.startTime,
      endTime: config.endTime,
      summary: config.summary,
      entities: config.entities || [],
      embedding,
    };
  }

  /**
   * Auto-chunk a session's events into episodes.
   *
   * Strategy: groups events into fixed-size windows (default 10),
   * concatenates their content, and creates one episode per group.
   * In production, this could use an LLM to summarize instead.
   */
  async autoChunkSession(sessionId: string, windowSize = 10): Promise<Episode[]> {
    const events = this.getEvents(sessionId, 1000);
    if (events.length === 0) {
      return [];
    }

    const episodes: Episode[] = [];
    for (let i = 0; i < events.length; i += windowSize) {
      const chunk = events.slice(i, i + windowSize);
      const firstEvent = chunk[0];
      const lastEvent = chunk[chunk.length - 1];
      const summary = chunk.map((e) => `[${e.type}] ${e.content}`).join("\n");

      // Extract unique entity names from metadata
      const entities = extractEntities(chunk);

      const episode = await this.createEpisode({
        sessionId,
        startTime: firstEvent.timestamp,
        endTime: lastEvent.timestamp,
        summary,
        entities,
      });
      episodes.push(episode);
    }

    log.info(`Auto-chunked session ${sessionId} into ${episodes.length} episodes`);
    return episodes;
  }

  /** Get episodes for a session */
  getEpisodes(sessionId: string): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE session_id = ? ORDER BY start_time")
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToEpisode(row));
  }

  // ============================================================================
  // SEMANTIC SEARCH
  // ============================================================================

  /**
   * Search episodes by semantic similarity.
   *
   * Uses cosine similarity between the query embedding and stored episode embeddings.
   * Falls back to text-based search if embeddings are unavailable.
   */
  async searchEpisodes(query: string, limit = 5, threshold = 0.3): Promise<EpisodeSearchResult[]> {
    if (!this.embedFn) {
      log.warn("No embedding function set — falling back to text search");
      return this.textSearchEpisodes(query, limit);
    }

    const queryEmbedding = await this.embedFn(query);

    // Load all episodes with embeddings
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes
       WHERE session_id IN (SELECT id FROM agi_sessions WHERE agent_id = ?)
       AND embedding IS NOT NULL`,
      )
      .all(this.agentId) as Array<Record<string, unknown>>;

    const scored: EpisodeSearchResult[] = [];
    for (const row of rows) {
      const embedding = sqlToJson<number[]>(row.embedding as string);
      if (!embedding || embedding.length === 0) {
        continue;
      }

      const score = cosineSimilarity(queryEmbedding, embedding);
      if (score >= threshold) {
        scored.push({
          episode: this.rowToEpisode(row),
          score,
        });
      }
    }

    return scored.toSorted((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Search sessions by summary similarity */
  async searchSessions(query: string, limit = 5, threshold = 0.3): Promise<SessionSearchResult[]> {
    if (!this.embedFn) {
      log.warn("No embedding function set — falling back to text search");
      return this.textSearchSessions(query, limit);
    }

    const queryEmbedding = await this.embedFn(query);

    const rows = this.db
      .prepare(`SELECT * FROM agi_sessions WHERE agent_id = ? AND embedding IS NOT NULL`)
      .all(this.agentId) as Array<Record<string, unknown>>;

    const scored: SessionSearchResult[] = [];
    for (const row of rows) {
      const embedding = sqlToJson<number[]>(row.embedding as string);
      if (!embedding || embedding.length === 0) {
        continue;
      }

      const score = cosineSimilarity(queryEmbedding, embedding);
      if (score >= threshold) {
        scored.push({
          session: this.rowToSession(row),
          score,
        });
      }
    }

    return scored.toSorted((a, b) => b.score - a.score).slice(0, limit);
  }

  // ============================================================================
  // TEXT SEARCH FALLBACK
  // ============================================================================

  private textSearchEpisodes(query: string, limit: number): EpisodeSearchResult[] {
    const queryLower = query.toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes
       WHERE session_id IN (SELECT id FROM agi_sessions WHERE agent_id = ?)
       AND LOWER(summary) LIKE ?
       ORDER BY start_time DESC LIMIT ?`,
      )
      .all(this.agentId, `%${queryLower}%`, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      episode: this.rowToEpisode(row),
      score: 0.5, // Fixed score for text matches
    }));
  }

  private textSearchSessions(query: string, limit: number): SessionSearchResult[] {
    const queryLower = query.toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT * FROM agi_sessions
       WHERE agent_id = ? AND LOWER(summary) LIKE ?
       ORDER BY start_time DESC LIMIT ?`,
      )
      .all(this.agentId, `%${queryLower}%`, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      session: this.rowToSession(row),
      score: 0.5,
    }));
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  getStats(): {
    totalSessions: number;
    totalEpisodes: number;
    totalEvents: number;
    avgEventsPerSession: number;
  } {
    type CountRow = { count: number };

    const sessions = this.db
      .prepare("SELECT COUNT(*) as count FROM agi_sessions WHERE agent_id = ?")
      .get(this.agentId) as CountRow;

    const episodes = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM episodes
       WHERE session_id IN (SELECT id FROM agi_sessions WHERE agent_id = ?)`,
      )
      .get(this.agentId) as CountRow;

    const events = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM agi_events
       WHERE session_id IN (SELECT id FROM agi_sessions WHERE agent_id = ?)`,
      )
      .get(this.agentId) as CountRow;

    return {
      totalSessions: sessions.count,
      totalEpisodes: episodes.count,
      totalEvents: events.count,
      avgEventsPerSession: sessions.count > 0 ? events.count / sessions.count : 0,
    };
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private rowToSession(row: Record<string, unknown>): EpisodicSession {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      startTime: new Date(row.start_time as string),
      endTime: sqlToDate(row.end_time as string | null),
      intent: (row.intent as string) || undefined,
      outcome: row.outcome as SessionOutcome,
      summary: (row.summary as string) || undefined,
      embedding: sqlToJson<number[]>(row.embedding as string | null),
    };
  }

  private rowToEpisode(row: Record<string, unknown>): Episode {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      startTime: new Date(row.start_time as string),
      endTime: new Date(row.end_time as string),
      summary: row.summary as string,
      entities: sqlToJson<string[]>(row.entities as string) || [],
      embedding: sqlToJson<number[]>(row.embedding as string | null),
    };
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

/** Cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator < 1e-10) {
    return 0;
  }
  return dotProduct / denominator;
}

/** Extract entity names from event metadata */
function extractEntities(events: SessionEvent[]): string[] {
  const entities = new Set<string>();
  for (const event of events) {
    if (event.metadata?.entity) {
      entities.add(String(event.metadata.entity));
    }
    if (event.metadata?.file) {
      entities.add(String(event.metadata.file));
    }
    if (event.metadata?.tool) {
      entities.add(String(event.metadata.tool));
    }
  }
  return Array.from(entities);
}

// ============================================================================
// FACTORY
// ============================================================================

const episodicManagers = new Map<string, EpisodicMemoryManager>();

export function getEpisodicMemory(agentId: string, embedFn?: EmbedFn): EpisodicMemoryManager {
  if (!episodicManagers.has(agentId)) {
    episodicManagers.set(agentId, new EpisodicMemoryManager(agentId, embedFn));
  }
  return episodicManagers.get(agentId)!;
}
