/**
 * Active Forgetting Mechanism for Memory System
 *
 * Inspired by biological active forgetting:
 * - Synaptic scaling during sleep (整体弱化，保留强连接)
 * - Retrieval-induced forgetting (回忆时抑制竞争记忆)
 * - Noise filtering (删除低价值噪音)
 *
 * Phase 1 implements:
 * - Noise filtering: delete chunks with low salience + low access_count
 * - Access-triggered salience boost: accessed memories get importance bump
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory-forgetting");

export interface ForgettingConfig {
  /** Minimum salience threshold for deletion (0-1) */
  minSalience: number;
  /** Minimum access count before considering for deletion */
  minAccessCount: number;
  /** Maximum age in ms before considering for deletion (default: 30 days) */
  maxAgeMs: number;
  /** Maximum number of chunks to delete in one run */
  maxDeletePerRun: number;
}

export interface ForgettingResult {
  deletedCount: number;
  deletedIds: string[];
  durationMs: number;
}

/** Default config matching Phase 1 design */
export const DEFAULT_FORGETTING_CONFIG: ForgettingConfig = {
  minSalience: 0.2,
  minAccessCount: 3,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  maxDeletePerRun: 100,
};

/**
 * Noise filtering: remove chunks that are both low-salience and rarely accessed.
 * This simulates the brain's ability to forget irrelevant noise.
 */
export function forgetNoiseChunks(
  db: DatabaseSync,
  config: Partial<ForgettingConfig> = {},
): ForgettingResult {
  const cfg: ForgettingConfig = { ...DEFAULT_FORGETTING_CONFIG, ...config };
  const startTime = Date.now();

  const cutoffTime = Date.now() - cfg.maxAgeMs;

  // Find chunks that meet all deletion criteria:
  // 1. salience below threshold (low importance)
  // 2. access_count below threshold (rarely accessed)
  // 3. older than cutoff time (had time to be forgotten naturally)
  const toDelete = db
    .prepare(
      `SELECT id FROM chunks
       WHERE salience < ?
         AND access_count < ?
         AND updated_at < ?
       ORDER BY salience ASC, access_count ASC
       LIMIT ?`,
    )
    .all(cfg.minSalience, cfg.minAccessCount, cutoffTime, cfg.maxDeletePerRun) as Array<{
    id: string;
  }>;

  if (toDelete.length === 0) {
    log.info("forgetNoise: no chunks to delete");
    return { deletedCount: 0, deletedIds: [], durationMs: Date.now() - startTime };
  }

  const deletedIds = toDelete.map((r) => r.id);

  // Delete from chunks table
  const deleteStmt = db.prepare(`DELETE FROM chunks WHERE id = ?`);
  db.exec(`BEGIN TRANSACTION`);
  try {
    for (const id of deletedIds) {
      deleteStmt.run(id);
    }
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    log.error(`forgetNoise: failed to delete chunks: ${err}`);
    throw err;
  }

  log.info(`forgetNoise: deleted ${deletedIds.length} chunks`);
  return {
    deletedCount: deletedIds.length,
    deletedIds,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Record that a chunk was accessed. Call this after search results are returned.
 * Phase 1: This just increments access_count.
 * Future: Could also boost salience based on recency/frequency patterns.
 */
export function recordChunkAccess(db: DatabaseSync, chunkId: string): void {
  db.prepare(`UPDATE chunks SET access_count = access_count + 1 WHERE id = ?`).run(chunkId);
}

/**
 * Record accesses for multiple chunks at once (batch operation).
 */
export function recordChunkAccessBatch(db: DatabaseSync, chunkIds: string[]): void {
  if (chunkIds.length === 0) return;

  db.exec(`BEGIN TRANSACTION`);
  try {
    const stmt = db.prepare(`UPDATE chunks SET access_count = access_count + 1 WHERE id = ?`);
    for (const id of chunkIds) {
      stmt.run(id);
    }
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    log.error(`recordChunkAccessBatch: failed: ${err}`);
    throw err;
  }
}

/**
 * Boost salience for a chunk. Called when memory is explicitly important
 * (e.g., user said "remember this", or memory is referenced frequently).
 *
 * Phase 1: Simple linear boost.
 * Future: Could use reinforcement learning-like updates.
 */
export function boostSalience(
  db: DatabaseSync,
  chunkId: string,
  boostAmount: number = 0.1,
): void {
  // Cap salience at 1.0
  db.prepare(
    `UPDATE chunks SET salience = MIN(1.0, salience + ?) WHERE id = ?`,
  ).run(boostAmount, chunkId);
}

/**
 * Decay salience for all chunks (synaptic scaling analogy).
 * Call this during "sleep" consolidation period.
 *
 * Phase 1: Simple multiplicative decay.
 * Future: Could preserve high-value memories better.
 */
export function synapticScalingDecay(db: DatabaseSync, decayFactor: number = 0.95): void {
  db.exec(`BEGIN TRANSACTION`);
  try {
    // Decay all salience values, but don't go below 0.1
    db.prepare(
      `UPDATE chunks SET salience = MAX(0.1, salience * ?) WHERE salience > 0.1`,
    ).run(decayFactor);

    // Also decay access_count slightly (memories used less become less salient)
    db.prepare(
      `UPDATE chunks SET access_count = MAX(0, FLOOR(access_count * ?)) WHERE access_count > 0`,
    ).run(decayFactor);

    db.exec(`COMMIT`);
    log.info(`synapticScalingDecay: applied decay factor ${decayFactor}`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    log.error(`synapticScalingDecay: failed: ${err}`);
    throw err;
  }
}

/**
 * Get statistics about chunk salience distribution.
 * Useful for monitoring and tuning forgetting thresholds.
 */
export function getSalienceStats(db: DatabaseSync): {
  total: number;
  avgSalience: number;
  lowSalience: number; // count with salience < 0.3
  veryLowSalience: number; // count with salience < 0.1
  avgAccessCount: number;
  neverAccessed: number;
} {
  const stats = db.prepare(`SELECT
    COUNT(*) as total,
    AVG(salience) as avgSalience,
    SUM(CASE WHEN salience < 0.3 THEN 1 ELSE 0 END) as lowSalience,
    SUM(CASE WHEN salience < 0.1 THEN 1 ELSE 0 END) as veryLowSalience,
    AVG(access_count) as avgAccessCount,
    SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) as neverAccessed
  FROM chunks`).get() as {
    total: number;
    avgSalience: number | null;
    lowSalience: number | null;
    veryLowSalience: number | null;
    avgAccessCount: number | null;
    neverAccessed: number | null;
  };

  return {
    total: stats.total,
    avgSalience: stats.avgSalience ?? 0.5,
    lowSalience: stats.lowSalience ?? 0,
    veryLowSalience: stats.veryLowSalience ?? 0,
    avgAccessCount: stats.avgAccessCount ?? 0,
    neverAccessed: stats.neverAccessed ?? 0,
  };
}
