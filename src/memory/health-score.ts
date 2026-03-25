/**
 * Memory health score calculation.
 *
 * Computes a composite 0-10 score based on multiple factors:
 * - Index freshness (is the index recent?)
 * - Embedding availability (can we do vector search?)
 * - Content coverage (do we have indexed content?)
 * - MEMORY.md recency (has it been updated recently?)
 * - Daily note activity (has the agent written notes?)
 * - Fallback status (are we on a degraded backend?)
 */
import fs from "node:fs";
import path from "node:path";
import type { MemoryProviderStatus } from "./types.js";

const DAILY_NOTE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

export type MemoryHealthInput = {
  /** Provider status from the search manager */
  status: MemoryProviderStatus | null;
  /** Whether embedding probe succeeded */
  embeddingOk: boolean;
  /** Agent workspace directory */
  workspaceDir: string;
};

export type MemoryHealthScore = {
  /** Composite score 0-10 */
  score: number;
  /** Letter grade */
  grade: "A" | "B" | "C" | "D" | "F";
  /** Individual factor scores */
  factors: {
    indexContent: number;
    embedding: number;
    memoryMdRecency: number;
    dailyNoteActivity: number;
    noFallback: number;
  };
  /** Human-readable issues */
  issues: string[];
};

/**
 * Compute a memory health score (0-10).
 *
 * Weights:
 * - Index content:      3 points (has indexed files/chunks)
 * - Embedding:          2 points (vector search available)
 * - MEMORY.md recency:  2 points (updated within 7 days)
 * - Daily note activity: 2 points (notes written recently)
 * - No fallback:        1 point  (on primary backend)
 */
export function computeMemoryHealthScore(input: MemoryHealthInput): MemoryHealthScore {
  const issues: string[] = [];
  const factors = {
    indexContent: 0,
    embedding: 0,
    memoryMdRecency: 0,
    dailyNoteActivity: 0,
    noFallback: 0,
  };

  const { status, embeddingOk, workspaceDir } = input;

  // Factor 1: Index content (0-3 points)
  if (status) {
    const fileCount = status.files ?? 0;
    const chunkCount = status.chunks ?? 0;
    if (fileCount > 0 && (status.backend === "qmd" || chunkCount > 0)) {
      factors.indexContent = fileCount >= 5 ? 3 : fileCount >= 2 ? 2 : 1;
    } else {
      issues.push("No indexed content");
    }
  } else {
    issues.push("Memory search unavailable");
  }

  // Factor 2: Embedding availability (0-2 points)
  if (embeddingOk) {
    factors.embedding = 2;
  } else {
    factors.embedding = 0;
    issues.push("Embeddings unavailable");
  }

  // Collect all root dirs to check for MEMORY.md and daily notes.
  // Prefer status.memoryRoots (all collection root paths the manager actually scans),
  // then fall back to workspaceDir + extraPaths. This ensures we check the right
  // paths even when the configured workspace differs from the indexed paths.
  const allWorkspaceDirs: string[] = [];
  const addDir = (d: string) => { if (d && !allWorkspaceDirs.includes(d)) allWorkspaceDirs.push(d); };
  if (status?.memoryRoots?.length) {
    for (const r of status.memoryRoots) addDir(r);
  } else {
    if (status?.workspaceDir) addDir(status.workspaceDir);
    for (const extra of status?.extraPaths ?? []) addDir(extra);
  }
  // Always include the passed-in workspaceDir as a fallback
  addDir(workspaceDir);

  // Factor 3: MEMORY.md recency (0-2 points) — check all workspace dirs, use best
  let bestMemoryMdDaysSince: number | null = null;
  for (const dir of allWorkspaceDirs) {
    for (const name of ["MEMORY.md", "memory.md"]) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        const days = (Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000);
        if (bestMemoryMdDaysSince === null || days < bestMemoryMdDaysSince) {
          bestMemoryMdDaysSince = days;
        }
      } catch {
        // File not found in this dir — try next
      }
    }
  }
  if (bestMemoryMdDaysSince !== null) {
    if (bestMemoryMdDaysSince < 3) {
      factors.memoryMdRecency = 2;
    } else if (bestMemoryMdDaysSince < 7) {
      factors.memoryMdRecency = 1;
    } else {
      factors.memoryMdRecency = 0;
      issues.push(`MEMORY.md not updated in ${Math.floor(bestMemoryMdDaysSince)} days`);
    }
  } else {
    factors.memoryMdRecency = 0;
    issues.push("MEMORY.md missing");
  }

  // Factor 4: Daily note activity (0-2 points) — check memory/ subdir in all workspace dirs
  let recentNotes = 0;
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  for (const dir of allWorkspaceDirs) {
    const memoryDir = path.join(dir, "memory");
    try {
      if (fs.existsSync(memoryDir)) {
        const entries = fs.readdirSync(memoryDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && DAILY_NOTE_PATTERN.test(entry.name)) {
            const dateStr = entry.name.replace(".md", "");
            const fileDate = new Date(dateStr + "T00:00:00Z");
            if (fileDate.getTime() >= threeDaysAgo) {
              recentNotes++;
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  if (recentNotes >= 2) {
    factors.dailyNoteActivity = 2;
  } else if (recentNotes >= 1) {
    factors.dailyNoteActivity = 1;
  } else {
    factors.dailyNoteActivity = 0;
    issues.push("No recent daily notes");
  }

  // Factor 5: No fallback (0-1 point)
  if (status && !status.fallback) {
    factors.noFallback = 1;
  } else if (status?.fallback) {
    issues.push(`Using fallback: ${status.fallback.from}`);
  }

  const score =
    factors.indexContent +
    factors.embedding +
    factors.memoryMdRecency +
    factors.dailyNoteActivity +
    factors.noFallback;

  const grade: MemoryHealthScore["grade"] =
    score >= 9 ? "A" : score >= 7 ? "B" : score >= 5 ? "C" : score >= 3 ? "D" : "F";

  return { score, grade, factors, issues };
}
