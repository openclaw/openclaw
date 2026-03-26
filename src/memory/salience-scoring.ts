/**
 * Salience-Enhanced Search Ranking
 *
 * Integrates memory importance (salience) and usage patterns into search ranking.
 *
 * Formula: finalScore = baseScore * (1 + salience) * log(access_count + 1)
 *
 * This means:
 * - High salience memories are boosted (they're important to remember)
 * - Frequently accessed memories get a boost (they're habitually relevant)
 * - The log() prevents recently-accessed from dominating too much
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemorySearchResult } from "./types.js";

export interface SalienceBoostConfig {
  /** Weight of salience in final score (0-1) */
  salienceWeight: number;
  /** Weight of access_count in final score (0-1) */
  accessWeight: number;
  /** Minimum base score threshold to consider for boosting */
  minBaseScore: number;
}

export const DEFAULT_SALIENCE_BOOST_CONFIG: SalienceBoostConfig = {
  salienceWeight: 0.3,
  accessWeight: 0.2,
  minBaseScore: 0.1,
};

/**
 * Fetch salience and access_count for given chunk IDs.
 */
function fetchSalienceData(
  db: DatabaseSync,
  chunkIds: string[],
): Map<string, { salience: number; access_count: number }> {
  if (chunkIds.length === 0) return new Map();

  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, salience, access_count FROM chunks WHERE id IN (${placeholders})`,
    )
    .all(...chunkIds) as Array<{
    id: string;
    salience: number;
    access_count: number;
  }>;

  return new Map(rows.map((r) => [r.id, { salience: r.salience, access_count: r.access_count }]));
}

/**
 * Re-rank search results by integrating salience and access patterns.
 *
 * Formula: finalScore = baseScore * salienceBoost * accessBoost
 * Where:
 *   salienceBoost = 1 + salienceWeight * salience
 *   accessBoost = 1 + accessWeight * log(access_count + 1)
 */
export function rerankWithSalience(
  db: DatabaseSync,
  results: MemorySearchResult[],
  config: Partial<SalienceBoostConfig> = {},
): MemorySearchResult[] {
  const cfg: SalienceBoostConfig = { ...DEFAULT_SALIENCE_BOOST_CONFIG, ...config };

  if (results.length === 0) return results;

  // Fetch salience data for all results
  const ids = results.map((r) => `${r.path}:${r.startLine}:${r.endLine}`);
  const salienceData = fetchSalienceData(db, ids);

  return results
    .map((result) => {
      const key = `${result.path}:${result.startLine}:${result.endLine}`;
      const data = salienceData.get(key);

      if (!data || result.score < cfg.minBaseScore) {
        return result;
      }

      const salienceBoost = 1 + cfg.salienceWeight * data.salience;
      const accessBoost = 1 + cfg.accessWeight * Math.log(data.access_count + 1);
      const boostedScore = result.score * salienceBoost * accessBoost;

      return {
        ...result,
        score: Math.min(1.0, boostedScore), // Cap at 1.0
      };
    })
    .toSorted((a, b) => b.score - a.score);
}

/**
 * Quick salience boost factor for a single chunk (for real-time boosting).
 * Returns the multiplicative boost factor.
 */
export function computeSalienceBoost(
  salience: number,
  accessCount: number,
  config: Partial<SalienceBoostConfig> = {},
): number {
  const cfg: SalienceBoostConfig = { ...DEFAULT_SALIENCE_BOOST_CONFIG, ...config };
  const salienceBoost = 1 + cfg.salienceWeight * salience;
  const accessBoost = 1 + cfg.accessWeight * Math.log(accessCount + 1);
  return salienceBoost * accessBoost;
}
