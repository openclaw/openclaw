/**
 * Sleep Consolidation Service
 *
 * Inspired by memory consolidation during sleep in the human brain:
 * - Hippocampal replay: Recent memories are "replayed" in compressed form
 * - Systems consolidation: Transfer from hippocampus (fast) to neocortex (slow)
 * - Synaptic downscaling: Overall weakening but selective strengthening
 * - Emotional attenuation: Gradual reduction of emotional intensity
 *
 * This module orchestrates nightly memory optimization:
 * 1. Select candidate memories for replay
 * 2. Establish new associations between related memories
 * 3. Apply synaptic scaling (global decay with preservation of strong connections)
 * 4. Update memory tiers based on usage patterns
 * 5. Apply noise filtering (forgetting)
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { forgetNoiseChunks, synapticScalingDecay, type ForgettingConfig } from "./forgetting.js";
import { evaluateAndUpdateTiers, type MemoryTierConfig } from "./memory-tier.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

const log = createSubsystemLogger("memory-consolidation");

export interface ConsolidationConfig {
  /** Maximum memories to consider for replay */
  replayCandidateLimit: number;
  /** Minimum salience to be considered for replay */
  replayMinSalience: number;
  /** Maximum associations to create per consolidation run */
  maxNewAssociations: number;
  /** Minimum similarity threshold for auto-linking */
  autoLinkMinSimilarity: number;
  /** Synaptic scaling decay factor (0-1, lower = more aggressive decay) */
  synapticDecayFactor: number;
  /** Tier evaluation config */
  tierConfig: Partial<MemoryTierConfig>;
  /** Forgetting config */
  forgettingConfig: Partial<ForgettingConfig>;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  replayCandidateLimit: 50,
  replayMinSalience: 0.4,
  maxNewAssociations: 20,
  autoLinkMinSimilarity: 0.75,
  synapticDecayFactor: 0.95,
  tierConfig: {},
  forgettingConfig: {},
};

export interface ConsolidationResult {
  durationMs: number;
  statistics: {
    replayCandidates: number;
    newAssociations: number;
    promotedToLongTerm: number;
    demotedToWorking: number;
    forgotten: number;
    synapticScaled: boolean;
  };
  errors: string[];
}

/** Phase 1: Generate a unique ID */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Run memory consolidation (the "sleep" phase).
 *
 * This should be called during idle periods (e.g., when gateway is not busy,
 * or configured to run at specific times like 3-4 AM).
 *
 * @returns ConsolidationResult with statistics about what was done
 */
export function runConsolidation(
  db: DatabaseSync,
  config: Partial<ConsolidationConfig> = {},
): ConsolidationResult {
  const startTime = Date.now();
  const cfg: ConsolidationConfig = { ...DEFAULT_CONSOLIDATION_CONFIG, ...config };
  const errors: string[] = [];

  log.info("starting sleep consolidation");

  try {
    // Phase 1: Hippocampal replay - select high-salience recent memories
    const replayCandidates = selectReplayCandidates(db, cfg);
    log.info(`selected ${replayCandidates.length} replay candidates`);

    // Phase 2: Auto-link related memories (establish new associations)
    const newAssociations = autoLinkMemories(db, replayCandidates, cfg);
    log.info(`created ${newAssociations} new associations`);

    // Phase 3: Synaptic scaling - global decay with preservation
    try {
      synapticScalingDecay(db, cfg.synapticDecayFactor);
    } catch (err) {
      errors.push(`synaptic scaling failed: ${err}`);
    }

    // Phase 4: Tier evaluation and promotion/demotion
    let tierPromoted = 0;
    let tierDemoted = 0;
    try {
      const tierResult = evaluateAndUpdateTiers(db, cfg.tierConfig);
      tierPromoted = tierResult.promoted;
      tierDemoted = tierResult.demoted;
    } catch (err) {
      errors.push(`tier evaluation failed: ${err}`);
    }

    // Phase 5: Noise filtering (active forgetting)
    let forgottenCount = 0;
    try {
      const forgetResult = forgetNoiseChunks(db, cfg.forgettingConfig);
      forgottenCount = forgetResult.deletedCount;
    } catch (err) {
      errors.push(`forgetting failed: ${err}`);
    }

    const result: ConsolidationResult = {
      durationMs: Date.now() - startTime,
      statistics: {
        replayCandidates: replayCandidates.length,
        newAssociations,
        promotedToLongTerm: tierPromoted,
        demotedToWorking: tierDemoted,
        forgotten: forgottenCount,
        synapticScaled: errors.filter((e) => e.includes("synaptic")).length === 0,
      },
      errors,
    };

    log.info(`consolidation complete in ${result.durationMs}ms: ${JSON.stringify(result.statistics)}`);
    return result;
  } catch (err) {
    const errorMsg = `consolidation failed: ${err}`;
    log.error(errorMsg);
    return {
      durationMs: Date.now() - startTime,
      statistics: {
        replayCandidates: 0,
        newAssociations: 0,
        promotedToLongTerm: 0,
        demotedToWorking: 0,
        forgotten: 0,
        synapticScaled: false,
      },
      errors: [...errors, errorMsg],
    };
  }
}

/**
 * Select candidate memories for replay during consolidation.
 * These are high-salience recent memories that should be strengthened.
 */
function selectReplayCandidates(
  db: DatabaseSync,
  cfg: ConsolidationConfig,
): Array<{ id: string; embedding: number[]; content: string; salience: number }> {
  const rows = db
    .prepare(
      `SELECT id, embedding, text, salience FROM chunks
       WHERE salience >= ?
       ORDER BY salience DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(cfg.replayMinSalience, cfg.replayCandidateLimit) as Array<{
    id: string;
    embedding: string;
    text: string;
    salience: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    embedding: parseEmbedding(row.embedding),
    content: row.text,
    salience: row.salience,
  }));
}

/**
 * Auto-link memories that are semantically similar.
 * This simulates the brain's ability to find unexpected connections.
 *
 * Phase 1: Simple pairwise similarity check among replay candidates
 * Future: Could use more sophisticated clustering or graph algorithms
 */
function autoLinkMemories(
  db: DatabaseSync,
  candidates: Array<{ id: string; embedding: number[]; content: string; salience: number }>,
  cfg: ConsolidationConfig,
): number {
  if (candidates.length < 2) return 0;

  let newLinkCount = 0;
  const now = Date.now();

  db.exec(`BEGIN TRANSACTION`);
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO associations (id, source_id, target_id, strength, type, created_at)
      VALUES (?, ?, ?, ?, 'semantic', ?)
    `);

    for (let i = 0; i < candidates.length && newLinkCount < cfg.maxNewAssociations; i++) {
      for (let j = i + 1; j < candidates.length && newLinkCount < cfg.maxNewAssociations; j++) {
        const a = candidates[i];
        const b = candidates[j];

        // Skip if already linked
        const existing = db
          .prepare(
            `SELECT 1 FROM associations
             WHERE ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))
             LIMIT 1`,
          )
          .get(a.id, b.id, b.id, a.id);

        if (existing) continue;

        // Calculate similarity
        const similarity = cosineSimilarity(a.embedding, b.embedding);

        if (similarity >= cfg.autoLinkMinSimilarity) {
          // Create bidirectional association
          const strength = (similarity - cfg.autoLinkMinSimilarity) / (1 - cfg.autoLinkMinSimilarity); // Normalize to 0-1
          const id1 = generateId();
          const id2 = generateId();

          stmt.run(id1, a.id, b.id, strength, now);
          stmt.run(id2, b.id, a.id, strength, now);

          newLinkCount++;
        }
      }
    }

    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    log.error(`autoLinkMemories failed: ${err}`);
    throw err;
  }

  return newLinkCount;
}

/**
 * Get consolidation statistics without running consolidation.
 */
export function getConsolidationStats(db: DatabaseSync): {
  totalMemories: number;
  highValueMemories: number;
  existingAssociations: number;
  avgAssociationStrength: number;
  tierDistribution: { longTerm: number; shortTerm: number; working: number };
} {
  const totalMemories = (
    db.prepare(`SELECT COUNT(*) as count FROM chunks`).get() as { count: number }
  ).count;

  const highValueMemories = (
    db
      .prepare(`SELECT COUNT(*) as count FROM chunks WHERE salience >= 0.6`)
      .get() as { count: number }
  ).count;

  const associationStats = db
    .prepare(`SELECT COUNT(*) as count, AVG(strength) as avg FROM associations`)
    .get() as { count: number; avg: number | null };

  const tierRows = db
    .prepare(`SELECT tier, COUNT(*) as count FROM chunks GROUP BY tier`)
    .all() as Array<{ tier: string | null; count: number }>;

  const tierDistribution = { longTerm: 0, shortTerm: 0, working: 0 };
  for (const row of tierRows) {
    const tier = (row.tier ?? "short_term") as keyof typeof tierDistribution;
    if (tier in tierDistribution) {
      tierDistribution[tier] = row.count;
    }
  }

  return {
    totalMemories,
    highValueMemories,
    existingAssociations: associationStats.count,
    avgAssociationStrength: associationStats.avg ?? 0,
    tierDistribution,
  };
}
