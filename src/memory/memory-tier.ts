/**
 * Memory Tier System
 *
 * Inspired by human memory hierarchy:
 * - Working Memory: Fast, limited capacity, short-lived (~4 chunks, seconds-minutes)
 * - Short-Term Memory: Intermediate storage (~7 items, 15-30 seconds)
 * - Long-Term Memory: Persistent, organized, potentially unlimited
 *
 * This module implements tier-based memory management with promotion/demotion.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory-tier");

/** Memory tier levels */
export type MemoryTier = "working" | "short_term" | "long_term";

/** Configuration for tier behavior */
export interface MemoryTierConfig {
  /** Working memory: max entries before eviction */
  workingMaxEntries: number;
  /** Short-term memory: max age in ms before demotion */
  shortTermMaxAgeMs: number;
  /** Short-term memory: promotion threshold (access_count * salience) */
  promotionThreshold: number;
  /** Long-term memory: min age in ms before considered for consolidation */
  longTermMinAgeMs: number;
}

export const DEFAULT_TIER_CONFIG: MemoryTierConfig = {
  workingMaxEntries: 100,
  shortTermMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  promotionThreshold: 10, // salience * access_count > this to promote
  longTermMinAgeMs: 24 * 60 * 60 * 1000, // 1 day
};

/** Statistics about memory tiers */
export interface MemoryTierStats {
  working: number;
  shortTerm: number;
  longTerm: number;
  total: number;
}

/**
 * Get the current tier distribution statistics.
 */
export function getTierStats(db: DatabaseSync): MemoryTierStats {
  const rows = db.prepare(`SELECT tier, COUNT(*) as count FROM chunks GROUP BY tier`).all() as Array<{
    tier: string | null;
    count: number;
  }>;

  const stats: MemoryTierStats = {
    working: 0,
    shortTerm: 0,
    longTerm: 0,
    total: 0,
  };

  for (const row of rows) {
    const tier = (row.tier as MemoryTier) ?? "short_term"; // null defaults to short_term
    if (tier in stats) {
      stats[tier as keyof MemoryTierStats] = row.count;
    }
    stats.total += row.count;
  }

  return stats;
}

/**
 * Set the tier for a chunk.
 */
export function setChunkTier(db: DatabaseSync, chunkId: string, tier: MemoryTier): void {
  db.prepare(`UPDATE chunks SET tier = ? WHERE id = ?`).run(tier, chunkId);
}

/**
 * Set tiers for multiple chunks at once.
 */
export function setChunkTierBatch(db: DatabaseSync, updates: Array<{ id: string; tier: MemoryTier }>): void {
  if (updates.length === 0) return;

  db.exec(`BEGIN TRANSACTION`);
  try {
    const stmt = db.prepare(`UPDATE chunks SET tier = ? WHERE id = ?`);
    for (const { id, tier } of updates) {
      stmt.run(tier, id);
    }
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    log.error(`setChunkTierBatch failed: ${err}`);
    throw err;
  }
}

/**
 * Evaluate and update tiers based on memory access patterns.
 * This should be called periodically (e.g., during "sleep" consolidation).
 *
 * Promotion rules:
 * - High salience + high access_count → long_term
 * - Working memory overflow → short_term
 *
 * Demotion rules:
 * - Low salience + low access_count + old → forget (handled by forgetting.ts)
 * - Short_term max age exceeded → consider demotion
 */
export function evaluateAndUpdateTiers(
  db: DatabaseSync,
  config: Partial<MemoryTierConfig> = {},
): { promoted: number; demoted: number } {
  const cfg: MemoryTierConfig = { ...DEFAULT_TIER_CONFIG, ...config };
  const now = Date.now();

  let promoted = 0;
  let demoted = 0;

  db.exec(`BEGIN TRANSACTION`);
  try {
    // Promote high-value memories to long_term
    // Criteria: high salience * access_count, and old enough
    const promotionCandidates = db.prepare(`
      SELECT id FROM chunks
      WHERE (tier IS NULL OR tier = 'short_term')
        AND (salience * access_count) > ?
        AND updated_at < ?
    `).all(cfg.promotionThreshold, now - cfg.longTermMinAgeMs) as Array<{ id: string }>;

    if (promotionCandidates.length > 0) {
      const stmt = db.prepare(`UPDATE chunks SET tier = 'long_term' WHERE id = ?`);
      for (const { id } of promotionCandidates) {
        stmt.run(id);
      }
      promoted = promotionCandidates.length;
      log.info(`promoted ${promoted} chunks to long_term`);
    }

    // Demote old short_term memories that haven't been accessed
    // (they expire naturally)
    const demotionCandidates = db.prepare(`
      SELECT id FROM chunks
      WHERE tier = 'short_term'
        AND updated_at < ?
    `).all(now - cfg.shortTermMaxAgeMs) as Array<{ id: string }>;

    if (demotionCandidates.length > 0) {
      // Demote to working (they'll get forgotten soon if not accessed)
      const stmt = db.prepare(`UPDATE chunks SET tier = 'working' WHERE id = ?`);
      for (const { id } of demotionCandidates) {
        stmt.run(id);
      }
      demoted = demotionCandidates.length;
      log.info(`demoted ${demoted} chunks to working`);
    }

    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    log.error(`evaluateAndUpdateTiers failed: ${err}`);
    throw err;
  }

  return { promoted, demoted };
}

/**
 * Initialize tier column for existing chunks (backfill with 'short_term').
 */
export function initializeTiers(db: DatabaseSync): number {
  const result = db.prepare(`UPDATE chunks SET tier = 'short_term' WHERE tier IS NULL`).run();
  const count = result.changes;
  if (count > 0) {
    log.info(`initialized tiers for ${count} existing chunks`);
  }
  return count;
}

/**
 * Get chunks by tier.
 */
export function getChunksByTier(
  db: DatabaseSync,
  tier: MemoryTier,
  limit: number = 100,
): Array<{ id: string; path: string; salience: number; access_count: number }> {
  return db
    .prepare(
      `SELECT id, path, salience, access_count FROM chunks
       WHERE tier = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(tier, limit) as Array<{
    id: string;
    path: string;
    salience: number;
    access_count: number;
  }>;
}

/**
 * Calculate memory tier health score (for monitoring).
 */
export function getTierHealthScore(db: DatabaseSync): {
  score: number; // 0-100
  details: {
    longTermRatio: number; // % in long_term (healthy: 60-80%)
    avgSalience: number;
    neverAccessedPercent: number;
  };
} {
  const stats = getTierStats(db);

  if (stats.total === 0) {
    return {
      score: 100,
      details: { longTermRatio: 0, avgSalience: 0.5, neverAccessedPercent: 0 },
    };
  }

  const longTermRatio = stats.longTerm / stats.total;

  const salienceStats = db.prepare(`SELECT AVG(salience) as avg, SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) as never_accessed, COUNT(*) as total FROM chunks`).get() as {
    avg: number | null;
    never_accessed: number;
    total: number;
  };

  const avgSalience = salienceStats.avg ?? 0.5;
  const neverAccessedPercent = (salienceStats.never_accessed / stats.total) * 100;

  // Health score: combination of distribution and quality
  // Ideal: 60-80% in long_term, high avg salience, low never-accessed %
  const distributionScore = longTermRatio >= 0.6 && longTermRatio <= 0.8 ? 100 : 100 - Math.abs(longTermRatio - 0.7) * 200;
  const qualityScore = avgSalience * 100;
  const accessScore = 100 - neverAccessedPercent;

  const score = Math.round((distributionScore * 0.3 + qualityScore * 0.4 + accessScore * 0.3));

  return {
    score,
    details: {
      longTermRatio: Math.round(longTermRatio * 100),
      avgSalience: Math.round(avgSalience * 100) / 100,
      neverAccessedPercent: Math.round(neverAccessedPercent),
    },
  };
}
