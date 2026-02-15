/**
 * Tier Recall Tracking
 *
 * Records when chunks are recalled during search and tracks recall frequency
 * per file for tier transition decisions.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemorySearchResult } from "./types.js";
import type { MemoryTier } from "./tier-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/tier-recall");

export type RecallableResult = Pick<MemorySearchResult, "path" | "score"> & {
  id?: string;
  tier?: string;
};

/**
 * Batch-insert recall records for search results and update aggregates
 * in the memory_tiers table.
 */
export function recordChunkRecalls(params: {
  db: DatabaseSync;
  results: RecallableResult[];
  query: string;
  sessionKey?: string;
}): void {
  const { db, results, query, sessionKey } = params;
  if (results.length === 0) {
    return;
  }

  const now = Date.now();

  try {
    db.exec("BEGIN");

    const insertRecall = db.prepare(
      `INSERT OR IGNORE INTO chunk_recall (chunk_id, recalled_at, session_key, query, score, tier)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const upsertTier = db.prepare(
      `INSERT INTO memory_tiers (path, tier, recall_count, last_recalled_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(path) DO UPDATE SET
         recall_count = recall_count + 1,
         last_recalled_at = excluded.last_recalled_at`,
    );

    const pathsSeen = new Set<string>();
    for (const result of results) {
      const chunkId = result.id;
      const tier = (result.tier ?? "T1") as MemoryTier;

      if (chunkId) {
        insertRecall.run(chunkId, now, sessionKey ?? null, query, result.score ?? null, tier);
      }

      // Update file-level aggregates once per path
      if (!pathsSeen.has(result.path)) {
        pathsSeen.add(result.path);
        upsertTier.run(result.path, tier, now);
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    log.warn(`failed to record chunk recalls: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Count recalls for a given file path within a time window.
 */
export function getRecallFrequency(params: {
  db: DatabaseSync;
  path: string;
  windowHours: number;
}): number {
  const { db, path: filePath, windowHours } = params;
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;

  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM chunk_recall
       WHERE chunk_id IN (SELECT id FROM chunks WHERE path = ?)
         AND recalled_at >= ?`,
    )
    .get(filePath, cutoff) as { c: number } | undefined;

  return row?.c ?? 0;
}
