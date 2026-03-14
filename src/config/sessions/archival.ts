import fs from "node:fs/promises";

export type ArchivalParams = {
  sessionFile: string;
  keepLastTurns: number;
};

export type ArchivalResult = {
  archived: boolean;
  linesRemoved: number;
  linesKept: number;
  archiveMarkerLineIndex: number;
};

/**
 * Archive old turns from a JSONL session file, keeping only the last N turns.
 *
 * A "turn" starts at each user message. The function preserves the session
 * header (line 0) and inserts an archive marker after archival.
 *
 * File replacement is atomic (write to temp file, then rename).
 */
export async function archiveSessionTranscript(params: ArchivalParams): Promise<ArchivalResult> {
  const { sessionFile, keepLastTurns } = params;
  const noArchival: ArchivalResult = {
    archived: false,
    linesRemoved: 0,
    linesKept: 0,
    archiveMarkerLineIndex: 0,
  };

  let raw: string;
  try {
    raw = await fs.readFile(sessionFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return noArchival;
    }
    throw err;
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return noArchival;
  }

  // Count turns — a turn starts at each user message
  const turnStartIndices: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      const msg = parsed?.message;
      if (msg && typeof msg === "object" && (msg as Record<string, unknown>).role === "user") {
        turnStartIndices.push(i);
      }
    } catch {
      // skip malformed lines
    }
  }

  if (turnStartIndices.length <= keepLastTurns) {
    return noArchival;
  }

  // Find the cut point: keep last N turns
  const cutTurnIndex = turnStartIndices.length - keepLastTurns;
  const cutLineIndex = turnStartIndices[cutTurnIndex];
  if (cutLineIndex === undefined || cutLineIndex <= 0) {
    return noArchival;
  }

  const header = lines[0];
  const keptLines = lines.slice(cutLineIndex);

  // Count removed entries, excluding any prior archive markers
  let removedCount = 0;
  for (let i = 1; i < cutLineIndex; i++) {
    try {
      const p = JSON.parse(lines[i]);
      if (p && typeof p === "object" && (p as Record<string, unknown>).type !== "archive_marker") {
        removedCount++;
      }
    } catch {
      removedCount++; // count malformed lines as removed entries
    }
  }

  const archiveMarker = JSON.stringify({
    type: "archive_marker",
    archivedBeforeLineIndex: cutLineIndex,
    archivedAt: new Date().toISOString(),
    totalArchived: removedCount,
  });

  const newContent = [header, archiveMarker, ...keptLines].join("\n") + "\n";

  // Atomic write: temp file + rename (preserve original permissions)
  const stat = await fs.stat(sessionFile);
  const tmpFile = `${sessionFile}.archival-${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpFile, newContent, { encoding: "utf-8", mode: stat.mode });
    await fs.rename(tmpFile, sessionFile);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpFile);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }

  return {
    archived: true,
    linesRemoved: removedCount,
    linesKept: keptLines.length,
    archiveMarkerLineIndex: cutLineIndex,
  };
}
