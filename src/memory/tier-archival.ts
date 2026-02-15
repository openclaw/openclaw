/**
 * T2→T3 Archival, T3→T2 Promotion, and T3 Deletion
 *
 * - Archive: Move short-term files with low recall frequency to long-term storage
 * - Promote: Move long-term files with high recent recall back to short-term
 * - Purge: Delete long-term files with no recall past the deletion threshold
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedTierConfig, MemoryTierEntry } from "./tier-types.js";
import { ensureDir } from "./internal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/tier-archival");

export type ArchivalParams = {
  workspaceDir: string;
  db: DatabaseSync;
  tierConfig: ResolvedTierConfig;
};

/**
 * Archive short-term files with low recall to long-term storage.
 *
 * For each T2 file in memory_tiers: if recall count within the recall window
 * is at or below maxRecallCount AND the entry is older than noRecallHours,
 * move it from memory/short-term/ to memory/long-term/.
 */
export async function archiveShortTermToLongTerm(params: ArchivalParams): Promise<number> {
  const { workspaceDir, db, tierConfig } = params;
  const shortTermDir = path.join(workspaceDir, "memory", "short-term");
  const longTermDir = path.join(workspaceDir, "memory", "long-term");

  const rows = db
    .prepare(`SELECT path, tier, recall_count, last_recalled_at FROM memory_tiers WHERE tier = 'T2'`)
    .all() as MemoryTierEntry[];

  if (rows.length === 0) {
    return 0;
  }

  const now = Date.now();
  const noRecallCutoff = now - tierConfig.archival.noRecallHours * 60 * 60 * 1000;
  const windowCutoff = now - tierConfig.archival.recallWindowHours * 60 * 60 * 1000;

  let archived = 0;

  for (const entry of rows) {
    // Count recalls within the window
    const recallsInWindow = countRecallsInWindow(db, entry.path, windowCutoff);

    if (recallsInWindow > tierConfig.archival.maxRecallCount) {
      continue;
    }

    // Check if last recall is old enough
    const lastRecalled = entry.lastRecalledAt ?? 0;
    if (lastRecalled > noRecallCutoff) {
      continue;
    }

    // Also check file age — must have existed for at least noRecallHours
    const fileRow = db
      .prepare(`SELECT mtime FROM files WHERE path = ?`)
      .get(entry.path) as { mtime: number } | undefined;
    if (fileRow && fileRow.mtime > noRecallCutoff) {
      continue;
    }

    // Move the file
    const sourcePath = path.join(workspaceDir, entry.path);
    const filename = path.basename(entry.path);
    ensureDir(longTermDir);
    const targetPath = path.join(longTermDir, filename);
    const targetRelPath = path.relative(workspaceDir, targetPath).replace(/\\/g, "/");

    try {
      await fs.rename(sourcePath, targetPath);
    } catch (err) {
      // File might not exist on disk (only in index)
      log.debug(
        `archive: failed to move ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // Update SQLite tables — delete old entry, insert new one
    db.prepare(`DELETE FROM memory_tiers WHERE path = ?`).run(entry.path);
    db.prepare(
      `INSERT INTO memory_tiers (path, tier, recall_count, last_recalled_at)
       VALUES (?, 'T3', ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         tier = 'T3',
         recall_count = excluded.recall_count,
         last_recalled_at = excluded.last_recalled_at`,
    ).run(targetRelPath, entry.recallCount, entry.lastRecalledAt ?? null);
    db.prepare(`UPDATE files SET tier = 'T3', path = ? WHERE path = ?`).run(
      targetRelPath,
      entry.path,
    );
    db.prepare(`UPDATE chunks SET tier = 'T3', path = ? WHERE path = ?`).run(
      targetRelPath,
      entry.path,
    );

    archived += 1;
    log.debug(`archived ${entry.path} → ${targetRelPath}`);
  }

  // Update index manifests
  await updateIndexManifest(shortTermDir);
  if (archived > 0) {
    await updateIndexManifest(longTermDir);
  }

  return archived;
}

/**
 * Promote long-term files with high recent recall back to short-term.
 *
 * Checks T3 entries: if recall count within promotion window >= minRecallCount
 * and not within cooldown period, move from memory/long-term/ to memory/short-term/.
 */
export async function promoteToShortTerm(params: ArchivalParams): Promise<number> {
  const { workspaceDir, db, tierConfig } = params;
  const shortTermDir = path.join(workspaceDir, "memory", "short-term");
  const longTermDir = path.join(workspaceDir, "memory", "long-term");

  const rows = db
    .prepare(
      `SELECT path, tier, recall_count, last_recalled_at, promoted_at FROM memory_tiers WHERE tier = 'T3'`,
    )
    .all() as MemoryTierEntry[];

  if (rows.length === 0) {
    return 0;
  }

  const now = Date.now();
  const windowCutoff = now - tierConfig.promotion.recallWindowHours * 60 * 60 * 1000;
  const cooldownCutoff = now - tierConfig.promotion.cooldownHours * 60 * 60 * 1000;

  let promoted = 0;

  for (const entry of rows) {
    // Check cooldown
    if (entry.promotedAt && entry.promotedAt > cooldownCutoff) {
      continue;
    }

    // Count recalls within the promotion window
    const recallsInWindow = countRecallsInWindow(db, entry.path, windowCutoff);

    if (recallsInWindow < tierConfig.promotion.minRecallCount) {
      continue;
    }

    // Move the file
    const sourcePath = path.join(workspaceDir, entry.path);
    const filename = path.basename(entry.path);
    ensureDir(shortTermDir);
    const targetPath = path.join(shortTermDir, filename);
    const targetRelPath = path.relative(workspaceDir, targetPath).replace(/\\/g, "/");

    try {
      await fs.rename(sourcePath, targetPath);
    } catch (err) {
      log.debug(
        `promote: failed to move ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // Update SQLite tables — delete old entry, insert new one
    db.prepare(`DELETE FROM memory_tiers WHERE path = ?`).run(entry.path);
    db.prepare(
      `INSERT INTO memory_tiers (path, tier, promoted_at, recall_count)
       VALUES (?, 'T2', ?, 0)
       ON CONFLICT(path) DO UPDATE SET
         tier = 'T2',
         promoted_at = excluded.promoted_at,
         recall_count = 0`,
    ).run(targetRelPath, now);
    db.prepare(`UPDATE files SET tier = 'T2', path = ? WHERE path = ?`).run(
      targetRelPath,
      entry.path,
    );
    db.prepare(`UPDATE chunks SET tier = 'T2', path = ? WHERE path = ?`).run(
      targetRelPath,
      entry.path,
    );

    promoted += 1;
    log.debug(`promoted ${entry.path} → ${targetRelPath}`);
  }

  if (promoted > 0) {
    await updateIndexManifest(shortTermDir);
    await updateIndexManifest(longTermDir);
  }

  return promoted;
}

/**
 * Explicitly promote a specific file from T3 to T2.
 * Used by the memory_search tool's promoteTier action.
 */
export async function promoteSpecificFile(params: {
  workspaceDir: string;
  db: DatabaseSync;
  filePath: string;
}): Promise<boolean> {
  const { workspaceDir, db, filePath } = params;
  const shortTermDir = path.join(workspaceDir, "memory", "short-term");

  // Verify the file is T3
  const entry = db
    .prepare(`SELECT tier FROM memory_tiers WHERE path = ?`)
    .get(filePath) as { tier: string } | undefined;

  if (!entry || entry.tier !== "T3") {
    return false;
  }

  const sourcePath = path.join(workspaceDir, filePath);
  const filename = path.basename(filePath);
  ensureDir(shortTermDir);
  const targetPath = path.join(shortTermDir, filename);
  const targetRelPath = path.relative(workspaceDir, targetPath).replace(/\\/g, "/");

  try {
    await fs.rename(sourcePath, targetPath);
  } catch {
    return false;
  }

  const now = Date.now();
  db.prepare(`DELETE FROM memory_tiers WHERE path = ?`).run(filePath);
  db.prepare(
    `INSERT INTO memory_tiers (path, tier, promoted_at, recall_count)
     VALUES (?, 'T2', ?, 0)
     ON CONFLICT(path) DO UPDATE SET
       tier = 'T2',
       promoted_at = excluded.promoted_at,
       recall_count = 0`,
  ).run(targetRelPath, now);
  db.prepare(`UPDATE files SET tier = 'T2', path = ? WHERE path = ?`).run(targetRelPath, filePath);
  db.prepare(`UPDATE chunks SET tier = 'T2', path = ? WHERE path = ?`).run(targetRelPath, filePath);

  await updateIndexManifest(shortTermDir);
  await updateIndexManifest(path.join(workspaceDir, "memory", "long-term"));

  log.debug(`explicitly promoted ${filePath} → ${targetRelPath}`);
  return true;
}

/**
 * Purge long-term memories past the deletion threshold.
 */
export async function purgeLongTermMemories(params: ArchivalParams): Promise<number> {
  const { workspaceDir, db, tierConfig } = params;

  if (tierConfig.deletion.neverDelete) {
    return 0;
  }

  const rows = db
    .prepare(`SELECT path, last_recalled_at FROM memory_tiers WHERE tier = 'T3'`)
    .all() as Array<{ path: string; last_recalled_at: number | null }>;

  if (rows.length === 0) {
    return 0;
  }

  const cutoff = Date.now() - tierConfig.deletion.noRecallHours * 60 * 60 * 1000;
  let purged = 0;

  for (const row of rows) {
    const lastRecalled = row.last_recalled_at ?? 0;
    if (lastRecalled > cutoff) {
      continue;
    }

    const absPath = path.join(workspaceDir, row.path);
    try {
      await fs.unlink(absPath);
    } catch {
      // File may already be gone
    }

    // Remove from all SQLite tables
    db.prepare(`DELETE FROM memory_tiers WHERE path = ?`).run(row.path);
    db.prepare(`DELETE FROM files WHERE path = ?`).run(row.path);
    db.prepare(`DELETE FROM chunks WHERE path = ?`).run(row.path);
    try {
      db.prepare(
        `DELETE FROM chunk_recall WHERE chunk_id IN (SELECT id FROM chunks WHERE path = ?)`,
      ).run(row.path);
    } catch {
      // chunks already deleted
    }

    purged += 1;
    log.debug(`purged long-term memory: ${row.path}`);
  }

  if (purged > 0) {
    await updateIndexManifest(path.join(workspaceDir, "memory", "long-term"));
  }

  return purged;
}

function countRecallsInWindow(db: DatabaseSync, filePath: string, windowCutoff: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM chunk_recall
       WHERE chunk_id IN (SELECT id FROM chunks WHERE path = ?)
         AND recalled_at >= ?`,
    )
    .get(filePath, windowCutoff) as { c: number } | undefined;
  return row?.c ?? 0;
}

async function updateIndexManifest(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const mdFiles = entries.filter((e) => e.endsWith(".md"));
    const index: Record<string, { file: string; updatedAt: number }> = {};

    for (const file of mdFiles) {
      try {
        const stat = await fs.stat(path.join(dir, file));
        const topic = file.replace(/\.md$/, "");
        index[topic] = { file, updatedAt: stat.mtimeMs };
      } catch {
        continue;
      }
    }

    await fs.writeFile(path.join(dir, "_index.json"), JSON.stringify(index, null, 2), "utf-8");
  } catch {
    // Directory may not exist
  }
}
