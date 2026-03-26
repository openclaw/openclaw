/**
 * Neural-Inspired Active Forgetting Mechanisms
 *
 * Inspired by neuroscience of memory and forgetting:
 *
 * 1. Retrieval-Induced Forgetting (RI):
 *    - When you recall a memory, related competing memories are suppressed
 *    - This is an active inhibitory process, not just passive decay
 *    - Prevents interference from similar memories
 *
 * 2. Reconsolidation-Based Updating:
 *    - Retrieved memories become labile (unstable) again
 *    - During reconsolidation, memories can be modified or weakened
 *    - This is how memories are updated with new information
 *
 * 3. Active Behavioral Tagging:
 *    - Neuromodulators (dopamine, norepinephrine) tag memories for retention
 *    - Emotionally salient events get stronger encoding
 *    - Tags can be positive (preserve) or negative (forget)
 *
 * 4. Motivated Forgetting:
 *    - Prefrontal cortex can actively suppress unwanted memories
 *    - Emotional regulation affects what gets forgotten
 *
 * These mechanisms make forgetting ADAPTIVE, not just a bug.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("neural-forgetting");

// ============================================================================
// Types
// ============================================================================

export interface ForgettingMechanismResult {
  mechanism: string;
  affectedChunks: string[];
  strengthChanges: Array<{ chunkId: string; oldSalience: number; newSalience: number }>;
  deletedChunks: string[];
  durationMs: number;
}

export interface RetrievalInducedForgettingConfig {
  /** When recalling a chunk, suppress competitors */
  suppressionRatio: number; // 0-1, how much to suppress competitors
  /** Minimum similarity to be considered a competitor */
  competitorSimilarityThreshold: number;
  /** Maximum competitors to suppress per retrieval */
  maxCompetitors: number;
  /** Suppression decay over time (0-1 per day) */
  dailySuppressionDecay: number;
}

export const DEFAULT_RETRIEVAL_INDUCED_CONFIG: RetrievalInducedForgettingConfig = {
  suppressionRatio: 0.2, // Suppress competitors by 20%
  competitorSimilarityThreshold: 0.6, // Must be 60% similar to be a competitor
  maxCompetitors: 5,
  dailySuppressionDecay: 0.1, // 10% of suppression wears off per day
};

export interface ReconsolidationConfig {
  /** How many times a chunk must be accessed before reconsolidation triggers */
  reconsolidationThreshold: number;
  /** How much salience can change during reconsolidation */
  maxSalienceChange: number;
  /** Period after retrieval where memory is labile (ms) */
  labileWindowMs: number;
}

export const DEFAULT_RECONSOLIDATION_CONFIG: ReconsolidationConfig = {
  reconsolidationThreshold: 3,
  maxSalienceChange: 0.15,
  labileWindowMs: 6 * 60 * 60 * 1000, // 6 hours
};

// ============================================================================
// Retrieval-Induced Forgetting
// ============================================================================

/**
 * Retrieval-Induced Forgetting (RI)
 *
 * When a memory is retrieved, related competing memories are actively suppressed.
 * This prevents interference and keeps memory retrieval efficient.
 *
 * @param db Database
 * @param retrievedChunkId The chunk that was just retrieved
 * @param config Configuration
 * @returns Information about suppressed chunks
 */
export function retrievalInducedForgetting(
  db: DatabaseSync,
  retrievedChunkId: string,
  config: Partial<RetrievalInducedForgettingConfig> = {},
): ForgettingMechanismResult {
  const startTime = Date.now();
  const cfg = { ...DEFAULT_RETRIEVAL_INDUCED_CONFIG, ...config };

  log.info(`retrieval-induced forgetting for chunk ${retrievedChunkId}`);

  // Get the retrieved chunk's embedding and schema
  const retrieved = db
    .prepare(`SELECT id, embedding, schema_type FROM chunks WHERE id = ?`)
    .get(retrievedChunkId) as { id: string; embedding: string; schema_type: string | null } | null;

  if (!retrieved) {
    return { mechanism: "retrieval_induced", affectedChunks: [], strengthChanges: [], deletedChunks: [], durationMs: Date.now() - startTime };
  }

  // Find competing chunks (same schema, high similarity)
  // These are memories that would interfere with the retrieved one
  const competitors = db
    .prepare(
      `SELECT id, embedding, salience FROM chunks
       WHERE id != ?
         AND schema_type = ?
         AND salience > 0.2
       LIMIT ?`,
    )
    .all(retrievedChunkId, retrieved.schema_type ?? "semantic", cfg.maxCompetitors * 2) as Array<{
    id: string;
    embedding: string;
    salience: number;
  }>;

  if (competitors.length === 0) {
    return { mechanism: "retrieval_induced", affectedChunks: [], strengthChanges: [], deletedChunks: [], durationMs: Date.now() - startTime };
  }

  // Calculate suppression amounts based on similarity
  const suppressions: Array<{ id: string; currentSalience: number; suppressionAmount: number }> = [];

  for (const comp of competitors) {
    // Simple similarity check based on embedding hash (for performance)
    // In production, would compute actual cosine similarity
    const similarity = calculateSimpleSimilarity(retrieved.embedding, comp.embedding);

    if (similarity >= cfg.competitorSimilarityThreshold) {
      const suppressionAmount = comp.salience * cfg.suppressionRatio * similarity;
      suppressions.push({
        id: comp.id,
        currentSalience: comp.salience,
        suppressionAmount,
      });

      if (suppressions.length >= cfg.maxCompetitors) break;
    }
  }

  // Apply suppression
  const strengthChanges: Array<{ chunkId: string; oldSalience: number; newSalience: number }> = [];

  db.exec(`BEGIN TRANSACTION`);
  try {
    const updateStmt = db.prepare(`UPDATE chunks SET salience = ? WHERE id = ?`);

    for (const sup of suppressions) {
      const newSalience = Math.max(0.05, sup.currentSalience - sup.suppressionAmount);
      updateStmt.run(newSalience, sup.id);
      strengthChanges.push({ chunkId: sup.id, oldSalience: sup.currentSalience, newSalience });
    }

    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    log.error(`retrieval-induced forgetting failed: ${err}`);
  }

  log.info(`suppressed ${strengthChanges.length} competing chunks`);

  return {
    mechanism: "retrieval_induced",
    affectedChunks: suppressions.map((s) => s.id),
    strengthChanges,
    deletedChunks: [],
    durationMs: Date.now() - startTime,
  };
}

/**
 * Simple similarity calculation (placeholder for real cosine similarity).
 */
function calculateSimpleSimilarity(embeddingA: string, embeddingB: string): number {
  // For now, use a simple hash comparison
  // In production, would parse embeddings and compute cosine similarity
  if (embeddingA === embeddingB) return 1.0;

  // Simple check: if first/last chars match, assume some similarity
  const aStart = embeddingA.slice(0, 10);
  const bStart = embeddingB.slice(0, 10);
  const aEnd = embeddingA.slice(-10);
  const bEnd = embeddingB.slice(-10);

  let similarity = 0;
  if (aStart === bStart) similarity += 0.3;
  if (aEnd === bEnd) similarity += 0.3;
  if (embeddingA.length === embeddingB.length) similarity += 0.2;

  return Math.min(0.9, similarity);
}

// ============================================================================
// Reconsolidation-Based Updating
// ============================================================================

/**
 * Reconsolidation-Based Memory Updating
 *
 * When a memory is retrieved multiple times, it enters a "labile" (unstable) state
 * during which it can be modified or even erased.
 *
 * This function checks if a memory needs reconsolidation and applies updates.
 */
export function checkReconsolidation(
  db: DatabaseSync,
  chunkId: string,
  config: Partial<ReconsolidationConfig> = {},
): { needsReconsolidation: boolean; salienceChange?: number; phase: "stable" | "labile" | "reconsolidating" } {
  const cfg = { ...DEFAULT_RECONSOLIDATION_CONFIG, ...config };

  const chunk = db
    .prepare(`SELECT access_count, salience, updated_at FROM chunks WHERE id = ?`)
    .get(chunkId) as { access_count: number; salience: number; updated_at: number } | null;

  if (!chunk) {
    return { needsReconsolidation: false, phase: "stable" };
  }

  // Check if access count indicates reconsolidation threshold reached
  const atThreshold = chunk.access_count >= cfg.reconsolidationThreshold;

  // Check if we're in the labile window after retrieval
  const timeSinceUpdate = Date.now() - chunk.updated_at;
  const inLabileWindow = timeSinceUpdate < cfg.labileWindowMs;

  if (atThreshold && inLabileWindow) {
    // Calculate potential salience adjustment
    // Memories that are over-accessed might have inflated importance
    const overAccessPenalty = Math.min(cfg.maxSalienceChange, (chunk.access_count - cfg.reconsolidationThreshold) * 0.01);

    return {
      needsReconsolidation: true,
      salienceChange: -overAccessPenalty, // Decrease slightly
      phase: "reconsolidating",
    };
  } else if (inLabileWindow) {
    return { needsReconsolidation: false, phase: "labile" };
  }

  return { needsReconsolidation: false, phase: "stable" };
}

/**
 * Apply reconsolidation update to a memory.
 */
export function applyReconsolidation(
  db: DatabaseSync,
  chunkId: string,
  newSalience: number,
  config: Partial<ReconsolidationConfig> = {},
): { success: boolean; oldSalience: number; newSalience: number } {
  const cfg = { ...DEFAULT_RECONSOLIDATION_CONFIG, ...config };

  const chunk = db
    .prepare(`SELECT salience FROM chunks WHERE id = ?`)
    .get(chunkId) as { salience: number } | null;

  if (!chunk) {
    return { success: false, oldSalience: 0, newSalience: 0 };
  }

  // Clamp salience change to max allowed
  const oldSalience = chunk.salience;
  const maxChange = cfg.maxSalienceChange;
  const clampedNewSalience = Math.max(0.1, Math.min(1.0, oldSalience + Math.max(-maxChange, Math.min(maxChange, newSalience - oldSalience))));

  db.prepare(`UPDATE chunks SET salience = ? WHERE id = ?`).run(clampedNewSalience, chunkId);

  log.info(`reconsolidation: ${chunkId} salience ${oldSalience} -> ${clampedNewSalience}`);

  return { success: true, oldSalience, newSalience: clampedNewSalience };
}

// ============================================================================
// Motivated Forgetting
// ============================================================================

/**
 * Motivated Forgetting
 *
 * Actively suppress memories that are tagged as unwanted.
 * This simulates the prefrontal cortex's ability to inhibit memories.
 */
export function motivatedForgetting(
  db: DatabaseSync,
  criteria: {
    /** Forgetting patterns (regex) */
    patterns?: string[];
    /** Below this salience threshold */
    maxSalience?: number;
    /** Older than this */
    olderThanMs?: number;
    /** From specific sources */
    sources?: string[];
  },
): ForgettingMechanismResult {
  const startTime = Date.now();

  let query = `SELECT id, text, salience FROM chunks WHERE 1=1`;
  const params: (string | number)[] = [];

  if (criteria.maxSalience !== undefined) {
    query += ` AND salience <= ?`;
    params.push(criteria.maxSalience);
  }

  if (criteria.olderThanMs !== undefined) {
    query += ` AND updated_at < ?`;
    params.push(Date.now() - criteria.olderThanMs);
  }

  if (criteria.sources && criteria.sources.length > 0) {
    query += ` AND source IN (${criteria.sources.map(() => "?").join(",")})`;
    params.push(...criteria.sources);
  }

  const candidates = db.prepare(query).all(...params) as Array<{ id: string; text: string; salience: number }>;

  const toSuppress: string[] = [];

  // Apply pattern matching if specified
  if (criteria.patterns && criteria.patterns.length > 0) {
    for (const chunk of candidates) {
      for (const pattern of criteria.patterns) {
        if (new RegExp(pattern, "i").test(chunk.text)) {
          toSuppress.push(chunk.id);
          break;
        }
      }
    }
  } else {
    toSuppress.push(...candidates.map((c) => c.id));
  }

  // Suppress (not delete) these memories
  const strengthChanges: Array<{ chunkId: string; oldSalience: number; newSalience: number }> = [];

  db.exec(`BEGIN TRANSACTION`);
  try {
    const updateStmt = db.prepare(`UPDATE chunks SET salience = ? WHERE id = ?`);
    for (const id of toSuppress) {
      const chunk = candidates.find((c) => c.id === id);
      if (chunk) {
        const newSalience = Math.max(0.1, chunk.salience * 0.5); // Halve the salience
        updateStmt.run(newSalience, id);
        strengthChanges.push({ chunkId: id, oldSalience: chunk.salience, newSalience });
      }
    }
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    log.error(`motivated forgetting failed: ${err}`);
  }

  return {
    mechanism: "motivated",
    affectedChunks: toSuppress,
    strengthChanges,
    deletedChunks: [],
    durationMs: Date.now() - startTime,
  };
}

// ============================================================================
// Emotional Tagging
// ============================================================================

/**
 * Emotional Tagging for Memory Enhancement
 *
 * Memories with emotional significance get stronger encoding.
 * This simulates the amygdala's role in memory consolidation.
 */
export function emotionalTagging(
  db: DatabaseSync,
  chunkId: string,
  emotionalValence: "positive" | "negative" | "neutral",
  intensity: number = 0.5, // 0-1
): void {
  const chunk = db.prepare(`SELECT salience FROM chunks WHERE id = ?`).get(chunkId) as { salience: number } | null;

  if (!chunk) return;

  // Positive emotions slightly boost salience
  // Negative emotions also boost (survival importance)
  // Neutral doesn't change
  let salienceBoost = 0;

  if (emotionalValence === "positive") {
    salienceBoost = intensity * 0.1;
  } else if (emotionalValence === "negative") {
    salienceBoost = intensity * 0.15; // Negative emotions often have stronger encoding
  }

  const newSalience = Math.min(1.0, chunk.salience + salienceBoost);
  db.prepare(`UPDATE chunks SET salience = ? WHERE id = ?`).run(newSalience, chunkId);

  log.info(`emotional tagging: ${chunkId} valence=${emotionalValence} intensity=${intensity}, salience ${chunk.salience} -> ${newSalience}`);
}

// ============================================================================
// forgetting Statistics
// ============================================================================

/**
 * Get statistics about forgetting mechanisms.
 */
export function getForgettingStats(
  db: DatabaseSync,
): {
  avgSalience: number;
  lowSalienceCount: number; // < 0.3
  veryLowSalienceCount: number; // < 0.15
  highSalienceCount: number; // > 0.7
  neverAccessedCount: number;
  potentialRI: number; // Chunks that could trigger RI
  inLabileWindow: number; // Chunks in reconsolidation window
} {
  const stats = db
    .prepare(
      `SELECT
        AVG(salience) as avg_salience,
        SUM(CASE WHEN salience < 0.3 THEN 1 ELSE 0 END) as low_count,
        SUM(CASE WHEN salience < 0.15 THEN 1 ELSE 0 END) as very_low_count,
        SUM(CASE WHEN salience > 0.7 THEN 1 ELSE 0 END) as high_count,
        SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) as never_accessed,
        SUM(CASE WHEN access_count >= 3 THEN 1 ELSE 0 END) as potential_ri
      FROM chunks`,
    )
    .get() as {
    avg_salience: number | null;
    low_count: number | null;
    very_low_count: number | null;
    high_count: number | null;
    never_accessed: number | null;
    potential_ri: number | null;
  };

  const labileWindow = 6 * 60 * 60 * 1000; // 6 hours
  const inLabile = db
    .prepare(
      `SELECT COUNT(*) as count FROM chunks WHERE updated_at > ?`,
    )
    .get(Date.now() - labileWindow) as { count: number };

  return {
    avgSalience: stats.avg_salience ?? 0.5,
    lowSalienceCount: stats.low_count ?? 0,
    veryLowSalienceCount: stats.very_low_count ?? 0,
    highSalienceCount: stats.high_count ?? 0,
    neverAccessedCount: stats.never_accessed ?? 0,
    potentialRI: stats.potential_ri ?? 0,
    inLabileWindow: inLabile.count,
  };
}
