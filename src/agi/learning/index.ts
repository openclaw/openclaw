/**
 * OpenClaw AGI - Learning Module
 *
 * Tracks patterns, corrections, and user preferences to improve
 * the agent's behavior over time. Supports reinforcement from
 * explicit user feedback and implicit signals.
 *
 * Uses the shared DatabaseManager — never creates its own DB connection.
 *
 * @module agi/learning
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getDatabase, jsonToSql, sqlToJson } from "../shared/db.js";

const log = createSubsystemLogger("agi:learning");

// ============================================================================
// TYPES
// ============================================================================

export interface LearnedPattern {
  id: string;
  agentId: string;
  pattern: string;
  context: string;
  confidence: number; // 0.0–1.0
  usageCount: number;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface Correction {
  id: string;
  agentId: string;
  mistake: string;
  correction: string;
  context: string;
  timestamp: Date;
}

export interface Preference {
  id: string;
  agentId: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
  timestamp: Date;
}

export type FeedbackType = "positive" | "negative" | "correction";

export interface FeedbackEvent {
  type: FeedbackType;
  context: string;
  detail?: string;
  timestamp: Date;
}

// ============================================================================
// LEARNING MANAGER
// ============================================================================

export class LearningManager {
  private db: DatabaseSync;
  private agentId: string;

  constructor(agentId: string, dbPath?: string) {
    this.agentId = agentId;
    this.db = getDatabase(agentId, dbPath);
    log.info(`LearningManager initialized for agent: ${agentId}`);
  }

  // ============================================================================
  // PATTERN LEARNING
  // ============================================================================

  /**
   * Learn a new pattern or reinforce an existing one.
   *
   * Patterns capture recurring agent behaviors (e.g., "user prefers
   * TypeScript over JavaScript", "always run tests after editing").
   * Each positive signal increments usage count and confidence.
   */
  learnPattern(pattern: string, context: string): LearnedPattern {
    // Check if pattern already exists
    const existing = this.findPattern(pattern);
    if (existing) {
      return this.reinforcePattern(existing.id);
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO learned_patterns (id, agent_id, pattern, context, confidence, usage_count, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.agentId, pattern, context, 0.5, 1, now, now);

    log.info(`Learned new pattern: ${pattern}`);
    return {
      id,
      agentId: this.agentId,
      pattern,
      context,
      confidence: 0.5,
      usageCount: 1,
      createdAt: new Date(now),
      lastUsedAt: new Date(now),
    };
  }

  /** Reinforce a pattern (increase confidence + usage count) */
  reinforcePattern(patternId: string): LearnedPattern {
    const now = new Date().toISOString();

    // Confidence growth: diminishing returns (0.5 → 0.75 → 0.875 → ...)
    this.db
      .prepare(
        `UPDATE learned_patterns SET
        confidence = MIN(1.0, confidence + (1.0 - confidence) * 0.25),
        usage_count = usage_count + 1,
        last_used_at = ?
      WHERE id = ?`,
      )
      .run(now, patternId);

    const row = this.db
      .prepare("SELECT * FROM learned_patterns WHERE id = ?")
      .get(patternId) as Record<string, unknown>;

    log.debug(`Reinforced pattern: ${patternId}`);
    return this.rowToPattern(row);
  }

  /** Weaken a pattern (decrease confidence due to negative feedback) */
  weakenPattern(patternId: string): void {
    this.db
      .prepare(
        `UPDATE learned_patterns SET
        confidence = MAX(0.0, confidence - 0.15)
      WHERE id = ?`,
      )
      .run(patternId);
    log.debug(`Weakened pattern: ${patternId}`);
  }

  /** Find a pattern by its description */
  findPattern(pattern: string): LearnedPattern | null {
    const row = this.db
      .prepare("SELECT * FROM learned_patterns WHERE agent_id = ? AND pattern = ?")
      .get(this.agentId, pattern) as Record<string, unknown> | undefined;
    return row ? this.rowToPattern(row) : null;
  }

  /** List patterns, optionally filtered by minimum confidence */
  listPatterns(minConfidence = 0.0, limit = 50): LearnedPattern[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM learned_patterns
       WHERE agent_id = ? AND confidence >= ?
       ORDER BY confidence DESC, usage_count DESC
       LIMIT ?`,
      )
      .all(this.agentId, minConfidence, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToPattern(row));
  }

  /** Get the most relevant patterns for a context */
  getRelevantPatterns(context: string, limit = 5): LearnedPattern[] {
    const contextLower = context.toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT * FROM learned_patterns
       WHERE agent_id = ? AND confidence >= 0.3
       AND (LOWER(context) LIKE ? OR LOWER(pattern) LIKE ?)
       ORDER BY confidence DESC, usage_count DESC
       LIMIT ?`,
      )
      .all(this.agentId, `%${contextLower}%`, `%${contextLower}%`, limit) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => this.rowToPattern(row));
  }

  /** Prune low-confidence patterns that haven't been used recently */
  pruneStalePatterns(maxAgeMs = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.db
      .prepare(
        `DELETE FROM learned_patterns
       WHERE agent_id = ? AND confidence < 0.3 AND last_used_at < ?`,
      )
      .run(this.agentId, cutoff);
    const pruned = Number(result.changes);
    log.info(`Pruned ${pruned} stale patterns`);
    return pruned;
  }

  // ============================================================================
  // CORRECTIONS
  // ============================================================================

  /** Record a user correction */
  recordCorrection(mistake: string, correction: string, context: string): Correction {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO corrections (id, agent_id, mistake, correction, context, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.agentId, mistake, correction, context, now);

    log.info(`Recorded correction: "${mistake}" → "${correction}"`);
    return {
      id,
      agentId: this.agentId,
      mistake,
      correction,
      context,
      timestamp: new Date(now),
    };
  }

  /** Get corrections relevant to a context */
  getCorrections(context?: string, limit = 20): Correction[] {
    if (context) {
      const rows = this.db
        .prepare(
          `SELECT * FROM corrections
         WHERE agent_id = ? AND LOWER(context) LIKE ?
         ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(this.agentId, `%${context.toLowerCase()}%`, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToCorrection(row));
    }

    const rows = this.db
      .prepare("SELECT * FROM corrections WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?")
      .all(this.agentId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToCorrection(row));
  }

  // ============================================================================
  // PREFERENCES
  // ============================================================================

  /** Set or update a preference */
  setPreference(category: string, key: string, value: string, confidence = 0.7): Preference {
    const now = new Date().toISOString();

    // Upsert by category + key
    const existing = this.getPreference(category, key);
    if (existing) {
      this.db
        .prepare(`UPDATE preferences SET value = ?, confidence = ?, timestamp = ? WHERE id = ?`)
        .run(value, confidence, now, existing.id);
      log.debug(`Updated preference: ${category}/${key} = ${value}`);
      return { ...existing, value, confidence, timestamp: new Date(now) };
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO preferences (id, agent_id, category, key, value, confidence, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.agentId, category, key, value, confidence, now);

    log.info(`Set preference: ${category}/${key} = ${value}`);
    return {
      id,
      agentId: this.agentId,
      category,
      key,
      value,
      confidence,
      timestamp: new Date(now),
    };
  }

  /** Get a specific preference */
  getPreference(category: string, key: string): Preference | null {
    const row = this.db
      .prepare("SELECT * FROM preferences WHERE agent_id = ? AND category = ? AND key = ?")
      .get(this.agentId, category, key) as Record<string, unknown> | undefined;
    return row ? this.rowToPreference(row) : null;
  }

  /** List preferences for a category */
  listPreferences(category?: string): Preference[] {
    if (category) {
      const rows = this.db
        .prepare("SELECT * FROM preferences WHERE agent_id = ? AND category = ? ORDER BY key")
        .all(this.agentId, category) as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToPreference(row));
    }

    const rows = this.db
      .prepare("SELECT * FROM preferences WHERE agent_id = ? ORDER BY category, key")
      .all(this.agentId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToPreference(row));
  }

  // ============================================================================
  // FEEDBACK PROCESSING
  // ============================================================================

  /**
   * Process explicit user feedback.
   *
   * Positive feedback: reinforces relevant patterns.
   * Negative feedback: weakens relevant patterns.
   * Correction: records the correction and weakens mistake patterns.
   */
  processFeedback(feedback: FeedbackEvent): void {
    switch (feedback.type) {
      case "positive": {
        const patterns = this.getRelevantPatterns(feedback.context, 3);
        for (const pattern of patterns) {
          this.reinforcePattern(pattern.id);
        }
        log.info(`Positive feedback processed: reinforced ${patterns.length} patterns`);
        break;
      }
      case "negative": {
        const patterns = this.getRelevantPatterns(feedback.context, 3);
        for (const pattern of patterns) {
          this.weakenPattern(pattern.id);
        }
        log.info(`Negative feedback processed: weakened ${patterns.length} patterns`);
        break;
      }
      case "correction": {
        if (feedback.detail) {
          this.recordCorrection(feedback.context, feedback.detail, feedback.context);
        }
        // Also weaken any patterns that match the mistake
        const patterns = this.getRelevantPatterns(feedback.context, 2);
        for (const pattern of patterns) {
          this.weakenPattern(pattern.id);
        }
        log.info("Correction feedback processed");
        break;
      }
    }
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  getStats(): {
    totalPatterns: number;
    highConfidencePatterns: number;
    totalCorrections: number;
    totalPreferences: number;
    avgConfidence: number;
  } {
    type CountRow = { count: number };
    type AvgRow = { avg: number | null };

    const patterns = this.db
      .prepare("SELECT COUNT(*) as count FROM learned_patterns WHERE agent_id = ?")
      .get(this.agentId) as CountRow;

    const highConf = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM learned_patterns WHERE agent_id = ? AND confidence >= 0.7",
      )
      .get(this.agentId) as CountRow;

    const corrections = this.db
      .prepare("SELECT COUNT(*) as count FROM corrections WHERE agent_id = ?")
      .get(this.agentId) as CountRow;

    const prefs = this.db
      .prepare("SELECT COUNT(*) as count FROM preferences WHERE agent_id = ?")
      .get(this.agentId) as CountRow;

    const avgConf = this.db
      .prepare("SELECT AVG(confidence) as avg FROM learned_patterns WHERE agent_id = ?")
      .get(this.agentId) as AvgRow;

    return {
      totalPatterns: patterns.count,
      highConfidencePatterns: highConf.count,
      totalCorrections: corrections.count,
      totalPreferences: prefs.count,
      avgConfidence: avgConf.avg || 0,
    };
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private rowToPattern(row: Record<string, unknown>): LearnedPattern {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      pattern: row.pattern as string,
      context: row.context as string,
      confidence: row.confidence as number,
      usageCount: row.usage_count as number,
      createdAt: new Date(row.created_at as string),
      lastUsedAt: new Date(row.last_used_at as string),
    };
  }

  private rowToCorrection(row: Record<string, unknown>): Correction {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      mistake: row.mistake as string,
      correction: row.correction as string,
      context: row.context as string,
      timestamp: new Date(row.timestamp as string),
    };
  }

  private rowToPreference(row: Record<string, unknown>): Preference {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      category: row.category as string,
      key: row.key as string,
      value: row.value as string,
      confidence: row.confidence as number,
      timestamp: new Date(row.timestamp as string),
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

const learningManagers = new Map<string, LearningManager>();

export function getLearningManager(agentId: string): LearningManager {
  if (!learningManagers.has(agentId)) {
    learningManagers.set(agentId, new LearningManager(agentId));
  }
  return learningManagers.get(agentId)!;
}
