/**
 * Event Store - SQLite Persistence Layer
 *
 * Persists events for replay, auditing, and debugging.
 * Uses node:sqlite (DatabaseSync) for synchronous operations.
 */

import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import type { EventEnvelope, EventStore, PersistedEvent, TopicPattern } from "./types.js";
import { topicMatches } from "./types.js";

// ============================================================================
// SQLite Helpers
// ============================================================================

const require = createRequire(import.meta.url);

function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

// ============================================================================
// Schema
// ============================================================================

const SCHEMA_VERSION = 1;

const CREATE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  persistence_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts INTEGER NOT NULL,
  persisted_at INTEGER NOT NULL,
  correlation_id TEXT,
  source TEXT,
  session_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_key) WHERE session_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id) WHERE correlation_id IS NOT NULL;
`;

const CREATE_META_TABLE = `
CREATE TABLE IF NOT EXISTS event_store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ============================================================================
// Implementation
// ============================================================================

export type EventStoreConfig = {
  /** Path to SQLite database file */
  dbPath: string;
  /** Max events to keep (older events pruned, default: 100000) */
  maxEvents?: number;
  /** Auto-prune interval in ms (default: 3600000 = 1 hour) */
  pruneInterval?: number;
  /** Logger */
  logger?: {
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  };
};

let persistenceIdCounter = 0;

function generatePersistenceId(): string {
  return `evt_${Date.now().toString(36)}_${(++persistenceIdCounter).toString(36)}`;
}

/**
 * Create an SQLite-backed event store
 */
export function createEventStore(config: EventStoreConfig): EventStore & {
  close: () => void;
  vacuum: () => void;
} {
  const {
    dbPath,
    maxEvents = 100_000,
    pruneInterval = 3_600_000,
    logger = {
      error: console.error,
      debug: () => {},
    },
  } = config;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open database
  const { DatabaseSync } = requireNodeSqlite();
  const db: DatabaseSync = new DatabaseSync(dbPath);

  // Initialize schema
  db.exec(CREATE_META_TABLE);
  db.exec(CREATE_EVENTS_TABLE);

  // Check/set schema version
  const versionStmt = db.prepare("SELECT value FROM event_store_meta WHERE key = 'schema_version'");
  const versionRow = versionStmt.get() as { value: string } | undefined;
  if (!versionRow) {
    db.prepare("INSERT INTO event_store_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  }

  // Prepared statements
  const insertStmt = db.prepare(`
    INSERT INTO events (persistence_id, seq, topic, payload, ts, persisted_at, correlation_id, source, session_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const readAfterStmt = db.prepare(`
    SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?
  `);

  const readRangeStmt = db.prepare(`
    SELECT * FROM events WHERE ts >= ? AND ts <= ? ORDER BY seq ASC LIMIT ?
  `);

  const latestSeqStmt = db.prepare(`
    SELECT MAX(seq) as max_seq FROM events
  `);

  const countStmt = db.prepare(`
    SELECT COUNT(*) as count FROM events
  `);

  const pruneByCountStmt = db.prepare(`
    DELETE FROM events WHERE seq <= (
      SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?
    )
  `);

  const pruneByTimeStmt = db.prepare(`
    DELETE FROM events WHERE ts < ?
  `);

  // Auto-prune timer
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  if (pruneInterval > 0) {
    pruneTimer = setInterval(() => {
      try {
        const count = (countStmt.get() as { count: number }).count;
        if (count > maxEvents) {
          const toDelete = count - maxEvents;
          pruneByCountStmt.run(maxEvents);
          logger.debug(`Pruned ${toDelete} old events`);
        }
      } catch (err) {
        logger.error(`Event store prune failed: ${String(err)}`);
      }
    }, pruneInterval);
  }

  // -------------------------------------------------------------------------
  // Store Operations
  // -------------------------------------------------------------------------

  const append = async (event: EventEnvelope): Promise<PersistedEvent> => {
    const persistenceId = generatePersistenceId();
    const persistedAt = Date.now();

    insertStmt.run(
      persistenceId,
      event.seq,
      event.topic,
      JSON.stringify(event.payload),
      event.ts,
      persistedAt,
      event.correlationId ?? null,
      event.source ?? null,
      event.sessionKey ?? null,
    );

    return {
      ...event,
      persistenceId,
      persistedAt,
    };
  };

  const rowToEvent = (row: Record<string, unknown>): PersistedEvent => ({
    topic: row.topic as string,
    payload: JSON.parse(row.payload as string),
    seq: row.seq as number,
    ts: row.ts as number,
    correlationId: row.correlation_id as string | undefined,
    source: row.source as string | undefined,
    sessionKey: row.session_key as string | undefined,
    persistenceId: row.persistence_id as string,
    persistedAt: row.persisted_at as number,
  });

  const readAfter = async (
    seq: number,
    options?: { limit?: number; topic?: TopicPattern },
  ): Promise<PersistedEvent[]> => {
    const limit = options?.limit ?? 1000;
    const rows = readAfterStmt.all(seq, limit) as Record<string, unknown>[];

    let events = rows.map(rowToEvent);

    // Filter by topic pattern if specified
    if (options?.topic) {
      events = events.filter((e) => topicMatches(options.topic!, e.topic));
    }

    return events;
  };

  const readRange = async (
    from: number,
    to: number,
    options?: { limit?: number; topic?: TopicPattern },
  ): Promise<PersistedEvent[]> => {
    const limit = options?.limit ?? 1000;
    const rows = readRangeStmt.all(from, to, limit) as Record<string, unknown>[];

    let events = rows.map(rowToEvent);

    // Filter by topic pattern if specified
    if (options?.topic) {
      events = events.filter((e) => topicMatches(options.topic!, e.topic));
    }

    return events;
  };

  const getLatestSeq = async (): Promise<number> => {
    const row = latestSeqStmt.get() as { max_seq: number | null };
    return row.max_seq ?? 0;
  };

  const prune = async (olderThan: number): Promise<number> => {
    const result = pruneByTimeStmt.run(olderThan);
    return Number(result.changes);
  };

  const close = (): void => {
    if (pruneTimer) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
    db.close();
  };

  const vacuum = (): void => {
    db.exec("VACUUM");
  };

  return {
    append,
    readAfter,
    readRange,
    getLatestSeq,
    prune,
    close,
    vacuum,
  };
}

// ============================================================================
// Default Store Location
// ============================================================================

/**
 * Get the default event store path
 */
export function getDefaultEventStorePath(): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(homeDir, ".clawdbot", "events.db");
}
