/**
 * ExperientialStore - SQLite-backed storage for experiential data.
 *
 * Each hook opens, uses, and closes the store per call.
 * WAL mode makes concurrent access safe.
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CompactionCheckpoint, ExperientialMoment, SessionSummary } from "./types.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { ensureExperientialSchema } from "./schema.js";

const DEFAULT_DB_DIR = path.join(os.homedir(), ".openclaw", "existence");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "experiential.db");

export class ExperientialStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const sqlite = requireNodeSqlite();
    this.db = new sqlite.DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    ensureExperientialSchema(this.db);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // --- Moments ---

  saveMoment(moment: ExperientialMoment): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO experiential_moments (
        id, version, timestamp, session_key, source, content, tool_name,
        significance_total, significance_emotional, significance_uncertainty,
        significance_relationship, significance_consequential, significance_reconstitution,
        disposition, reasons, emotional_signature, anchors, uncertainties
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      moment.id,
      moment.version,
      moment.timestamp,
      moment.sessionKey,
      moment.source,
      moment.content,
      moment.toolName ?? null,
      moment.significance.total,
      moment.significance.emotional,
      moment.significance.uncertainty,
      moment.significance.relationship,
      moment.significance.consequential,
      moment.significance.reconstitution,
      moment.disposition,
      JSON.stringify(moment.reasons),
      moment.emotionalSignature ?? null,
      JSON.stringify(moment.anchors),
      JSON.stringify(moment.uncertainties),
    );
  }

  getMomentsBySession(sessionKey: string): ExperientialMoment[] {
    const stmt = this.db.prepare(
      `SELECT * FROM experiential_moments WHERE session_key = ? ORDER BY timestamp ASC`,
    );
    const rows = stmt.all(sessionKey) as MomentRow[];
    return rows.map(rowToMoment);
  }

  getRecentMoments(limit: number, minSignificance = 0): ExperientialMoment[] {
    const stmt = this.db.prepare(
      `SELECT * FROM experiential_moments
       WHERE significance_total >= ?
       ORDER BY timestamp DESC LIMIT ?`,
    );
    const rows = stmt.all(minSignificance, limit) as MomentRow[];
    return rows.map(rowToMoment);
  }

  getBufferedMoments(sessionKey: string): ExperientialMoment[] {
    const stmt = this.db.prepare(
      `SELECT * FROM experiential_moments
       WHERE session_key = ? AND disposition = 'buffered'
       ORDER BY timestamp ASC`,
    );
    const rows = stmt.all(sessionKey) as MomentRow[];
    return rows.map(rowToMoment);
  }

  /** Transition all buffered moments for a session to 'archived'. */
  archiveBufferedMoments(sessionKey: string): number {
    const stmt = this.db.prepare(
      `UPDATE experiential_moments SET disposition = 'archived'
       WHERE session_key = ? AND disposition = 'buffered'`,
    );
    const result = stmt.run(sessionKey);
    return Number(result.changes);
  }

  // --- Session Summaries ---

  saveSessionSummary(summary: SessionSummary): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO session_summaries (
        id, version, session_key, started_at, ended_at, topics,
        emotional_arc, moment_count, key_anchors, open_uncertainties,
        reconstitution_hints
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      summary.id,
      summary.version,
      summary.sessionKey,
      summary.startedAt,
      summary.endedAt,
      JSON.stringify(summary.topics),
      summary.emotionalArc ?? null,
      summary.momentCount,
      JSON.stringify(summary.keyAnchors),
      JSON.stringify(summary.openUncertainties),
      JSON.stringify(summary.reconstitutionHints),
    );
  }

  getRecentSummaries(limit: number): SessionSummary[] {
    const stmt = this.db.prepare(`SELECT * FROM session_summaries ORDER BY ended_at DESC LIMIT ?`);
    const rows = stmt.all(limit) as SummaryRow[];
    return rows.map(rowToSummary);
  }

  getSessionSummary(sessionKey: string): SessionSummary | null {
    const stmt = this.db.prepare(`SELECT * FROM session_summaries WHERE session_key = ? LIMIT 1`);
    const rows = stmt.all(sessionKey) as SummaryRow[];
    return rows.length > 0 ? rowToSummary(rows[0]) : null;
  }

  // --- Compaction Checkpoints ---

  saveCheckpoint(checkpoint: CompactionCheckpoint): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO compaction_checkpoints (
        id, version, timestamp, session_key, trigger,
        active_topics, key_context_summary, open_uncertainties,
        conversation_anchors
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      checkpoint.id,
      checkpoint.version,
      checkpoint.timestamp,
      checkpoint.sessionKey,
      checkpoint.trigger,
      JSON.stringify(checkpoint.activeTopics),
      checkpoint.keyContextSummary,
      JSON.stringify(checkpoint.openUncertainties),
      JSON.stringify(checkpoint.conversationAnchors),
    );
  }

  getLatestCheckpoint(): CompactionCheckpoint | null {
    const stmt = this.db.prepare(
      `SELECT * FROM compaction_checkpoints ORDER BY timestamp DESC LIMIT 1`,
    );
    const rows = stmt.all() as CheckpointRow[];
    return rows.length > 0 ? rowToCheckpoint(rows[0]) : null;
  }

  getRecentCheckpoints(limit: number): CompactionCheckpoint[] {
    const stmt = this.db.prepare(
      `SELECT * FROM compaction_checkpoints ORDER BY timestamp DESC LIMIT ?`,
    );
    const rows = stmt.all(limit) as CheckpointRow[];
    return rows.map(rowToCheckpoint);
  }
}

// --- Row types and converters ---

type MomentRow = {
  id: string;
  version: number;
  timestamp: number;
  session_key: string;
  source: string;
  content: string;
  tool_name: string | null;
  significance_total: number;
  significance_emotional: number;
  significance_uncertainty: number;
  significance_relationship: number;
  significance_consequential: number;
  significance_reconstitution: number;
  disposition: string;
  reasons: string;
  emotional_signature: string | null;
  anchors: string;
  uncertainties: string;
};

type SummaryRow = {
  id: string;
  version: number;
  session_key: string;
  started_at: number;
  ended_at: number;
  topics: string;
  emotional_arc: string | null;
  moment_count: number;
  key_anchors: string;
  open_uncertainties: string;
  reconstitution_hints: string;
};

type CheckpointRow = {
  id: string;
  version: number;
  timestamp: number;
  session_key: string;
  trigger: string;
  active_topics: string;
  key_context_summary: string;
  open_uncertainties: string;
  conversation_anchors: string;
};

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToMoment(row: MomentRow): ExperientialMoment {
  return {
    id: row.id,
    version: row.version,
    timestamp: row.timestamp,
    sessionKey: row.session_key,
    source: row.source as ExperientialMoment["source"],
    content: row.content,
    toolName: row.tool_name ?? undefined,
    significance: {
      total: row.significance_total,
      emotional: row.significance_emotional,
      uncertainty: row.significance_uncertainty,
      relationship: row.significance_relationship,
      consequential: row.significance_consequential,
      reconstitution: row.significance_reconstitution,
    },
    disposition: row.disposition as ExperientialMoment["disposition"],
    reasons: parseJsonArray(row.reasons),
    emotionalSignature: row.emotional_signature ?? undefined,
    anchors: parseJsonArray(row.anchors),
    uncertainties: parseJsonArray(row.uncertainties),
  };
}

function rowToSummary(row: SummaryRow): SessionSummary {
  return {
    id: row.id,
    version: row.version,
    sessionKey: row.session_key,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    topics: parseJsonArray(row.topics),
    emotionalArc: row.emotional_arc ?? undefined,
    momentCount: row.moment_count,
    keyAnchors: parseJsonArray(row.key_anchors),
    openUncertainties: parseJsonArray(row.open_uncertainties),
    reconstitutionHints: parseJsonArray(row.reconstitution_hints),
  };
}

function rowToCheckpoint(row: CheckpointRow): CompactionCheckpoint {
  return {
    id: row.id,
    version: row.version,
    timestamp: row.timestamp,
    sessionKey: row.session_key,
    trigger: row.trigger,
    activeTopics: parseJsonArray(row.active_topics),
    keyContextSummary: row.key_context_summary,
    openUncertainties: parseJsonArray(row.open_uncertainties),
    conversationAnchors: parseJsonArray(row.conversation_anchors),
  };
}
