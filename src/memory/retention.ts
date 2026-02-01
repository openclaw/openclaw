/**
 * Memory Retention and Importance Scoring System
 *
 * Provides intelligent memory management with:
 * - Importance scoring based on recency, access frequency, and source type
 * - Configurable retention policies with pruning
 * - Memory access tracking for adaptive importance
 * - Support for explicit importance markers
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory-retention");

// =============================================================================
// Types
// =============================================================================

export type MemorySource = "memory" | "sessions";

export type MemoryImportance = "critical" | "high" | "normal" | "low" | "archive";

export type ChunkMetadata = {
  id: string;
  path: string;
  source: MemorySource;
  startLine: number;
  endLine: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  importance: MemoryImportance;
  importanceScore: number;
  /** Whether this chunk was explicitly marked important by user */
  pinned: boolean;
  /** Tags for categorization */
  tags: string[];
};

export type RetentionPolicy = {
  /** Whether retention management is enabled */
  enabled: boolean;
  /** Maximum age in days before considering for pruning (0 = no limit) */
  maxAgeDays: number;
  /** Minimum importance score to retain (0-1) */
  minImportanceScore: number;
  /** Maximum number of chunks to retain (0 = no limit) */
  maxChunks: number;
  /** Maximum storage size in bytes (0 = no limit) */
  maxStorageBytes: number;
  /** Days of inactivity before reducing importance */
  decayAfterDays: number;
  /** Importance decay rate per day after decay threshold (0-1) */
  decayRate: number;
  /** Whether to auto-archive instead of delete */
  archiveInsteadOfDelete: boolean;
  /** Source-specific retention multipliers */
  sourceWeights: {
    memory: number;
    sessions: number;
  };
};

export type RetentionStats = {
  totalChunks: number;
  totalBytes: number;
  byImportance: Record<MemoryImportance, number>;
  bySource: Record<MemorySource, number>;
  oldestChunkAge: number;
  averageImportanceScore: number;
  pruneCandidates: number;
};

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  enabled: true,
  maxAgeDays: 90,
  minImportanceScore: 0.1,
  maxChunks: 10000,
  maxStorageBytes: 100 * 1024 * 1024, // 100MB
  decayAfterDays: 14,
  decayRate: 0.05,
  archiveInsteadOfDelete: true,
  sourceWeights: {
    memory: 1.5, // Manual memories are more valuable
    sessions: 1.0,
  },
};

/** Base importance scores by level */
const IMPORTANCE_BASE_SCORES: Record<MemoryImportance, number> = {
  critical: 1.0,
  high: 0.8,
  normal: 0.5,
  low: 0.3,
  archive: 0.1,
};

/** Weights for importance calculation */
const IMPORTANCE_WEIGHTS = {
  recency: 0.3,
  accessFrequency: 0.25,
  sourceType: 0.2,
  explicitImportance: 0.25,
};

// =============================================================================
// Schema
// =============================================================================

const RETENTION_META_TABLE = "retention_meta";

/**
 * Ensure retention tracking schema exists
 */
export function ensureRetentionSchema(db: DatabaseSync): void {
  // Add retention columns to chunks table if not present
  try {
    db.exec(`
      ALTER TABLE chunks ADD COLUMN created_at INTEGER DEFAULT 0;
    `);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`
      ALTER TABLE chunks ADD COLUMN last_accessed_at INTEGER DEFAULT 0;
    `);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`
      ALTER TABLE chunks ADD COLUMN access_count INTEGER DEFAULT 0;
    `);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`
      ALTER TABLE chunks ADD COLUMN importance TEXT DEFAULT 'normal';
    `);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`
      ALTER TABLE chunks ADD COLUMN importance_score REAL DEFAULT 0.5;
    `);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`
      ALTER TABLE chunks ADD COLUMN pinned INTEGER DEFAULT 0;
    `);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`
      ALTER TABLE chunks ADD COLUMN tags TEXT DEFAULT '[]';
    `);
  } catch {
    // Column already exists
  }

  // Create retention metadata table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RETENTION_META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Create index for efficient pruning queries
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_importance_score
      ON chunks(importance_score);
    `);
  } catch {
    // Index already exists
  }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_last_accessed
      ON chunks(last_accessed_at);
    `);
  } catch {
    // Index already exists
  }
}

// =============================================================================
// Importance Scoring
// =============================================================================

/**
 * Calculate importance score for a memory chunk
 */
export function calculateImportanceScore(params: {
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  source: MemorySource;
  importance: MemoryImportance;
  pinned: boolean;
  policy: RetentionPolicy;
  now?: number;
}): number {
  const now = params.now ?? Date.now();

  // Pinned items always have maximum score
  if (params.pinned) {
    return 1.0;
  }

  // 1. Recency score (0-1) - exponential decay
  const ageMs = now - params.createdAt;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const recencyHalfLife = 30; // Score halves every 30 days
  const recencyScore = Math.exp((-ageDays / recencyHalfLife) * Math.LN2);

  // 2. Access frequency score (0-1) - logarithmic scale
  const accessScore = Math.min(1, Math.log10(params.accessCount + 1) / 2);

  // 3. Source type score
  const sourceWeight = params.policy.sourceWeights[params.source] ?? 1.0;
  const sourceScore = Math.min(1, sourceWeight / 1.5);

  // 4. Explicit importance score
  const baseImportance = IMPORTANCE_BASE_SCORES[params.importance] ?? 0.5;

  // 5. Apply decay if inactive
  let decayMultiplier = 1.0;
  if (params.policy.decayAfterDays > 0 && params.policy.decayRate > 0) {
    const lastAccessAgeMs = now - params.lastAccessedAt;
    const lastAccessDays = lastAccessAgeMs / (24 * 60 * 60 * 1000);
    if (lastAccessDays > params.policy.decayAfterDays) {
      const decayDays = lastAccessDays - params.policy.decayAfterDays;
      decayMultiplier = Math.max(0.1, 1 - decayDays * params.policy.decayRate);
    }
  }

  // Weighted combination
  const rawScore =
    IMPORTANCE_WEIGHTS.recency * recencyScore +
    IMPORTANCE_WEIGHTS.accessFrequency * accessScore +
    IMPORTANCE_WEIGHTS.sourceType * sourceScore +
    IMPORTANCE_WEIGHTS.explicitImportance * baseImportance;

  return Math.max(0, Math.min(1, rawScore * decayMultiplier));
}

/**
 * Determine importance level from score
 */
export function scoreToImportance(score: number): MemoryImportance {
  if (score >= 0.9) return "critical";
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "normal";
  if (score >= 0.2) return "low";
  return "archive";
}

// =============================================================================
// Access Tracking
// =============================================================================

/**
 * Record access to memory chunks (called after search returns results)
 */
export function recordChunkAccess(db: DatabaseSync, chunkIds: string[], now?: number): void {
  if (chunkIds.length === 0) return;

  const timestamp = now ?? Date.now();

  const stmt = db.prepare(`
    UPDATE chunks
    SET last_accessed_at = ?,
        access_count = access_count + 1
    WHERE id = ?
  `);

  for (const id of chunkIds) {
    try {
      stmt.run(timestamp, id);
    } catch (err) {
      log.debug(`Failed to record access for chunk ${id}: ${String(err)}`);
    }
  }
}

/**
 * Initialize timestamps for chunks that don't have them
 */
export function initializeChunkTimestamps(db: DatabaseSync, now?: number): number {
  const timestamp = now ?? Date.now();

  const result = db
    .prepare(`
    UPDATE chunks
    SET created_at = ?,
        last_accessed_at = ?
    WHERE created_at = 0 OR created_at IS NULL
  `)
    .run(timestamp, timestamp);

  return Number(result.changes);
}

// =============================================================================
// Importance Management
// =============================================================================

/**
 * Update importance scores for all chunks
 */
export function updateImportanceScores(
  db: DatabaseSync,
  policy: RetentionPolicy,
  now?: number,
): number {
  const timestamp = now ?? Date.now();

  const chunks = db
    .prepare(`
    SELECT id, source, created_at, last_accessed_at, access_count,
           importance, pinned
    FROM chunks
  `)
    .all() as Array<{
    id: string;
    source: MemorySource;
    created_at: number;
    last_accessed_at: number;
    access_count: number;
    importance: MemoryImportance;
    pinned: number;
  }>;

  const updateStmt = db.prepare(`
    UPDATE chunks
    SET importance_score = ?,
        importance = ?
    WHERE id = ?
  `);

  let updated = 0;
  for (const chunk of chunks) {
    const score = calculateImportanceScore({
      createdAt: chunk.created_at || timestamp,
      lastAccessedAt: chunk.last_accessed_at || timestamp,
      accessCount: chunk.access_count || 0,
      source: chunk.source,
      importance: chunk.importance || "normal",
      pinned: Boolean(chunk.pinned),
      policy,
      now: timestamp,
    });

    const newImportance = scoreToImportance(score);

    try {
      updateStmt.run(score, newImportance, chunk.id);
      updated++;
    } catch (err) {
      log.debug(`Failed to update importance for chunk ${chunk.id}: ${String(err)}`);
    }
  }

  return updated;
}

/**
 * Pin a chunk (mark as permanently important)
 */
export function pinChunk(db: DatabaseSync, chunkId: string): boolean {
  try {
    const result = db
      .prepare(`
      UPDATE chunks
      SET pinned = 1, importance_score = 1.0, importance = 'critical'
      WHERE id = ?
    `)
      .run(chunkId);
    return result.changes > 0;
  } catch {
    return false;
  }
}

/**
 * Unpin a chunk
 */
export function unpinChunk(db: DatabaseSync, chunkId: string): boolean {
  try {
    const result = db
      .prepare(`
      UPDATE chunks
      SET pinned = 0
      WHERE id = ?
    `)
      .run(chunkId);
    return result.changes > 0;
  } catch {
    return false;
  }
}

/**
 * Set explicit importance for a chunk
 */
export function setChunkImportance(
  db: DatabaseSync,
  chunkId: string,
  importance: MemoryImportance,
): boolean {
  try {
    const score = IMPORTANCE_BASE_SCORES[importance];
    const result = db
      .prepare(`
      UPDATE chunks
      SET importance = ?, importance_score = ?
      WHERE id = ?
    `)
      .run(importance, score, chunkId);
    return result.changes > 0;
  } catch {
    return false;
  }
}

// =============================================================================
// Pruning
// =============================================================================

export type PruneResult = {
  pruned: number;
  archived: number;
  errors: number;
  bytesFreed: number;
};

/**
 * Get chunks that are candidates for pruning
 */
export function getPruneCandidates(
  db: DatabaseSync,
  policy: RetentionPolicy,
  now?: number,
): Array<{ id: string; path: string; source: MemorySource; importance_score: number }> {
  const timestamp = now ?? Date.now();

  let query = `
    SELECT id, path, source, importance_score
    FROM chunks
    WHERE pinned = 0
  `;

  const params: (number | string)[] = [];

  // Filter by minimum importance
  if (policy.minImportanceScore > 0) {
    query += ` AND importance_score < ?`;
    params.push(policy.minImportanceScore);
  }

  // Filter by max age
  if (policy.maxAgeDays > 0) {
    const maxAgeMs = policy.maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = timestamp - maxAgeMs;
    query += ` AND created_at < ?`;
    params.push(cutoff);
  }

  query += ` ORDER BY importance_score ASC`;

  return db.prepare(query).all(...params) as Array<{
    id: string;
    path: string;
    source: MemorySource;
    importance_score: number;
  }>;
}

/**
 * Prune low-importance chunks based on policy
 */
export function pruneChunks(
  db: DatabaseSync,
  policy: RetentionPolicy,
  options?: {
    dryRun?: boolean;
    maxToPrune?: number;
    vectorTable?: string;
    ftsTable?: string;
    now?: number;
  },
): PruneResult {
  const result: PruneResult = {
    pruned: 0,
    archived: 0,
    errors: 0,
    bytesFreed: 0,
  };

  if (!policy.enabled) {
    return result;
  }

  const candidates = getPruneCandidates(db, policy, options?.now);

  if (candidates.length === 0) {
    return result;
  }

  const maxToPrune = options?.maxToPrune ?? candidates.length;
  const toPrune = candidates.slice(0, maxToPrune);

  if (options?.dryRun) {
    result.pruned = toPrune.length;
    return result;
  }

  const vectorTable = options?.vectorTable ?? "chunks_vec";
  const ftsTable = options?.ftsTable ?? "chunks_fts";

  for (const chunk of toPrune) {
    try {
      // Get chunk size before deleting
      const chunkData = db
        .prepare(`
        SELECT LENGTH(text) + LENGTH(embedding) as size
        FROM chunks WHERE id = ?
      `)
        .get(chunk.id) as { size: number } | undefined;

      if (policy.archiveInsteadOfDelete) {
        // Archive: set importance to 'archive' instead of deleting
        db.prepare(`
          UPDATE chunks
          SET importance = 'archive', importance_score = 0.05
          WHERE id = ?
        `).run(chunk.id);
        result.archived++;
      } else {
        // Delete from vector table
        try {
          db.prepare(`DELETE FROM ${vectorTable} WHERE id = ?`).run(chunk.id);
        } catch {
          // Vector table may not exist
        }

        // Delete from FTS table
        try {
          db.prepare(`DELETE FROM ${ftsTable} WHERE id = ?`).run(chunk.id);
        } catch {
          // FTS table may not exist
        }

        // Delete chunk
        db.prepare(`DELETE FROM chunks WHERE id = ?`).run(chunk.id);
        result.pruned++;
      }

      result.bytesFreed += chunkData?.size ?? 0;
    } catch (err) {
      log.debug(`Failed to prune chunk ${chunk.id}: ${String(err)}`);
      result.errors++;
    }
  }

  return result;
}

/**
 * Enforce storage limits by pruning lowest-importance chunks
 */
export function enforceStorageLimits(
  db: DatabaseSync,
  policy: RetentionPolicy,
  options?: {
    vectorTable?: string;
    ftsTable?: string;
  },
): PruneResult {
  const result: PruneResult = {
    pruned: 0,
    archived: 0,
    errors: 0,
    bytesFreed: 0,
  };

  if (!policy.enabled) {
    return result;
  }

  // Check chunk count limit
  if (policy.maxChunks > 0) {
    const countRow = db
      .prepare(`
      SELECT COUNT(*) as count FROM chunks WHERE pinned = 0
    `)
      .get() as { count: number };

    if (countRow.count > policy.maxChunks) {
      const excess = countRow.count - policy.maxChunks;
      const pruneResult = pruneChunks(db, policy, {
        maxToPrune: excess,
        vectorTable: options?.vectorTable,
        ftsTable: options?.ftsTable,
      });
      result.pruned += pruneResult.pruned;
      result.archived += pruneResult.archived;
      result.errors += pruneResult.errors;
      result.bytesFreed += pruneResult.bytesFreed;
    }
  }

  // Check storage size limit
  if (policy.maxStorageBytes > 0) {
    const sizeRow = db
      .prepare(`
      SELECT SUM(LENGTH(text) + LENGTH(embedding)) as total_size
      FROM chunks WHERE pinned = 0
    `)
      .get() as { total_size: number | null };

    const totalSize = sizeRow.total_size ?? 0;

    if (totalSize > policy.maxStorageBytes) {
      // Prune in batches until under limit
      let currentSize = totalSize;
      while (currentSize > policy.maxStorageBytes) {
        const pruneResult = pruneChunks(db, policy, {
          maxToPrune: 100,
          vectorTable: options?.vectorTable,
          ftsTable: options?.ftsTable,
        });

        if (pruneResult.pruned === 0 && pruneResult.archived === 0) {
          break; // No more candidates
        }

        result.pruned += pruneResult.pruned;
        result.archived += pruneResult.archived;
        result.errors += pruneResult.errors;
        result.bytesFreed += pruneResult.bytesFreed;
        currentSize -= pruneResult.bytesFreed;
      }
    }
  }

  return result;
}

// =============================================================================
// Statistics
// =============================================================================

/**
 * Get retention statistics
 */
export function getRetentionStats(
  db: DatabaseSync,
  policy: RetentionPolicy,
  now?: number,
): RetentionStats {
  const timestamp = now ?? Date.now();

  const totalRow = db
    .prepare(`
    SELECT COUNT(*) as count,
           SUM(LENGTH(text) + LENGTH(COALESCE(embedding, ''))) as bytes
    FROM chunks
  `)
    .get() as { count: number; bytes: number | null };

  const byImportanceRows = db
    .prepare(`
    SELECT importance, COUNT(*) as count
    FROM chunks
    GROUP BY importance
  `)
    .all() as Array<{ importance: MemoryImportance; count: number }>;

  const byImportance: Record<MemoryImportance, number> = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
    archive: 0,
  };
  for (const row of byImportanceRows) {
    byImportance[row.importance] = row.count;
  }

  const bySourceRows = db
    .prepare(`
    SELECT source, COUNT(*) as count
    FROM chunks
    GROUP BY source
  `)
    .all() as Array<{ source: MemorySource; count: number }>;

  const bySource: Record<MemorySource, number> = {
    memory: 0,
    sessions: 0,
  };
  for (const row of bySourceRows) {
    bySource[row.source] = row.count;
  }

  const oldestRow = db
    .prepare(`
    SELECT MIN(created_at) as oldest
    FROM chunks
    WHERE created_at > 0
  `)
    .get() as { oldest: number | null };

  const oldestAge = oldestRow.oldest ? (timestamp - oldestRow.oldest) / (24 * 60 * 60 * 1000) : 0;

  const avgScoreRow = db
    .prepare(`
    SELECT AVG(importance_score) as avg
    FROM chunks
  `)
    .get() as { avg: number | null };

  const pruneCandidates = getPruneCandidates(db, policy, timestamp);

  return {
    totalChunks: totalRow.count,
    totalBytes: totalRow.bytes ?? 0,
    byImportance,
    bySource,
    oldestChunkAge: oldestAge,
    averageImportanceScore: avgScoreRow.avg ?? 0.5,
    pruneCandidates: pruneCandidates.length,
  };
}
