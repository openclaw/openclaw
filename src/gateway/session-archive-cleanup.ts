import fs from "node:fs";
import path from "node:path";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import {
  isOrphanedSessionTmpFileName,
  parseSessionArchiveTimestamp,
} from "../config/sessions/artifacts.js";
import { resolveMaintenanceConfig } from "../config/sessions/store-maintenance.js";
import { cleanupArchivedSessionTranscripts } from "./session-utils.fs.js";

const ORPHAN_TMP_MAX_AGE_MS = 60 * 60_000; // 1 hour
const MAX_BAK_FILES_PER_DIR = 3;

/**
 * Proactive sweep of stale session archive files across all agent session
 * directories. Handles `.deleted.*`, `.reset.*`, `.bak.*` archives via the
 * existing retention logic and also cleans up orphaned `.tmp` files left by
 * interrupted atomic writes.
 */
export async function sweepSessionArchiveFiles(params: {
  stateDir: string;
}): Promise<{ removed: number; directories: number }> {
  const sessionDirs = await resolveAgentSessionDirs(params.stateDir);
  if (sessionDirs.length === 0) {
    return { removed: 0, directories: 0 };
  }

  const config = resolveMaintenanceConfig();
  let totalRemoved = 0;

  // Clean up old .deleted and .reset archives using existing retention config.
  for (const reason of ["deleted", "reset"] as const) {
    const retention = reason === "reset" ? config.resetArchiveRetentionMs : config.pruneAfterMs;
    if (retention == null || retention <= 0) {
      continue;
    }
    const result = await cleanupArchivedSessionTranscripts({
      directories: sessionDirs,
      olderThanMs: retention,
      reason,
    });
    totalRemoved += result.removed;
  }

  // Sweep each directory for orphaned .tmp files and excess .bak.* backups.
  const now = Date.now();
  for (const dir of sessionDirs) {
    const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);

    // Remove orphaned .tmp files older than the threshold.
    for (const entry of entries) {
      if (!isOrphanedSessionTmpFileName(entry)) {
        continue;
      }
      const fullPath = path.join(dir, entry);
      const stat = await fs.promises.stat(fullPath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      if (now - stat.mtimeMs < ORPHAN_TMP_MAX_AGE_MS) {
        continue;
      }
      totalRemoved += await fs.promises.rm(fullPath).then(
        () => 1,
        () => 0,
      );
    }

    // Trim excess .bak.* files, keeping only the most recent ones per base
    // name. This mirrors the rotation logic in rotateSessionFile().
    const bakByBase = new Map<string, string[]>();
    for (const entry of entries) {
      // Match genuine .bak.* archives: either ISO-timestamped (from archive
      // operations) or numeric (from rotateSessionFile's Date.now() suffix).
      // Plain indexOf(".bak.") would false-match session IDs that contain
      // ".bak." as a substring (e.g. "foo.bak.bar.jsonl.deleted.<ts>").
      const isIsoBak = parseSessionArchiveTimestamp(entry, "bak") != null;
      const isNumericBak = /\.bak\.\d+$/.test(entry);
      if (!isIsoBak && !isNumericBak) {
        continue;
      }
      const bakIdx = entry.lastIndexOf(".bak.");
      const base = entry.slice(0, bakIdx);
      let list = bakByBase.get(base);
      if (!list) {
        list = [];
        bakByBase.set(base, list);
      }
      list.push(entry);
    }

    for (const files of bakByBase.values()) {
      if (files.length <= MAX_BAK_FILES_PER_DIR) {
        continue;
      }
      // Sort descending so we keep the newest entries at the front.
      const sorted = files.toSorted().toReversed();
      for (const old of sorted.slice(MAX_BAK_FILES_PER_DIR)) {
        totalRemoved += await fs.promises.unlink(path.join(dir, old)).then(
          () => 1,
          () => 0,
        );
      }
    }
  }

  return { removed: totalRemoved, directories: sessionDirs.length };
}
