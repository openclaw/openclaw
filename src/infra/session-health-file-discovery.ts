/**
 * Session Health — File Discovery Helpers
 *
 * Shared file-discovery logic used by both the collector (for counting) and
 * the executor (for identifying specific files to act on). Extracted from
 * the collector to avoid duplicating directory-walking logic.
 *
 * All functions are pure scans — they read the filesystem but never mutate.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { classifyDiskArtifact } from "./session-health-classify.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveredFile = {
  /** Absolute path to the file. */
  absolutePath: string;

  /** Filename only (no directory). */
  name: string;

  /** File size in bytes. */
  size: number;

  /** Last modification time (ms since epoch). */
  mtimeMs: number;
};

// ---------------------------------------------------------------------------
// Directory scanner (shared primitive)
// ---------------------------------------------------------------------------

/**
 * Read all regular files in a sessions directory, returning metadata.
 * Returns empty array if the directory doesn't exist or can't be read.
 */
export async function readSessionDirFiles(sessionsDir: string): Promise<DiscoveredFile[]> {
  let dirEntries: import("node:fs").Dirent[];
  try {
    dirEntries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: DiscoveredFile[] = [];
  for (const dirent of dirEntries) {
    if (!dirent.isFile()) {
      continue;
    }
    try {
      const absPath = path.join(sessionsDir, dirent.name);
      const stat = await fs.stat(absPath);
      if (stat.isFile()) {
        files.push({
          absolutePath: absPath,
          name: String(dirent.name),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    } catch {
      // Skip files we can't stat (e.g., race condition deletion).
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Orphaned .tmp files (Tier 0)
// ---------------------------------------------------------------------------

/**
 * Discover orphaned .tmp files in a sessions directory.
 * These are artifacts from crashed atomic writes.
 */
export async function discoverOrphanedTmpFiles(sessionsDir: string): Promise<DiscoveredFile[]> {
  const files = await readSessionDirFiles(sessionsDir);
  return files.filter((f) => classifyDiskArtifact(f.name) === "orphanedTemp");
}

// ---------------------------------------------------------------------------
// Orphan transcripts — .jsonl files not referenced by the index (Tier 1)
// ---------------------------------------------------------------------------

/**
 * Discover .jsonl files on disk that have no matching session index entry.
 * These are "orphan transcripts" — files that exist on disk but aren't
 * referenced by any session in the store.
 *
 * Filename assumption: transcript files are named `${sessionId}.jsonl`.
 * This holds for all current OpenClaw session types. If a future session
 * type uses `sessionFile` overrides to decouple filename from sessionId,
 * this mapping would need to be updated. The same assumption exists in
 * the collector's drift detection (session-health-collector.ts).
 *
 * @param sessionsDir - The sessions directory to scan
 * @param indexedSessionIds - Set of sessionIds referenced by the store
 */
export async function discoverOrphanTranscripts(
  sessionsDir: string,
  indexedSessionIds: Set<string>,
): Promise<DiscoveredFile[]> {
  const files = await readSessionDirFiles(sessionsDir);
  return files.filter((f) => {
    if (classifyDiskArtifact(f.name) !== "active") {
      return false;
    }
    if (!f.name.endsWith(".jsonl")) {
      return false;
    }
    // Assumption: filename == sessionId + ".jsonl" (see doc comment above)
    const sessionId = f.name.replace(/\.jsonl$/, "");
    return !indexedSessionIds.has(sessionId);
  });
}

// ---------------------------------------------------------------------------
// Stale .deleted transcript archives (Tier 1)
// ---------------------------------------------------------------------------

/**
 * Discover .deleted transcript files that are past the retention window.
 *
 * @param sessionsDir - The sessions directory to scan
 * @param retentionMs - Retention window in milliseconds
 */
export async function discoverStaleDeletedTranscripts(
  sessionsDir: string,
  retentionMs: number,
): Promise<DiscoveredFile[]> {
  const files = await readSessionDirFiles(sessionsDir);
  const now = Date.now();
  return files.filter((f) => {
    if (classifyDiskArtifact(f.name) !== "deleted") {
      return false;
    }
    return now - f.mtimeMs > retentionMs;
  });
}

// ---------------------------------------------------------------------------
// Stale .reset transcript archives (Tier 1)
// ---------------------------------------------------------------------------

/**
 * Discover .reset transcript files that are past the retention window.
 *
 * @param sessionsDir - The sessions directory to scan
 * @param retentionMs - Retention window in milliseconds
 */
export async function discoverStaleResetTranscripts(
  sessionsDir: string,
  retentionMs: number,
): Promise<DiscoveredFile[]> {
  const files = await readSessionDirFiles(sessionsDir);
  const now = Date.now();
  return files.filter((f) => {
    if (classifyDiskArtifact(f.name) !== "reset") {
      return false;
    }
    return now - f.mtimeMs > retentionMs;
  });
}

// ---------------------------------------------------------------------------
// Helper: extract indexed session IDs from a loaded store
// ---------------------------------------------------------------------------

/**
 * Extract the set of sessionIds from a loaded session store.
 * Used to identify orphan transcripts.
 */
export function extractIndexedSessionIds(store: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(store)) {
    if (entry && typeof entry === "object") {
      const sessionId = (entry as Record<string, unknown>).sessionId;
      if (typeof sessionId === "string" && sessionId) {
        ids.add(sessionId);
      }
    }
  }
  return ids;
}
