/**
 * Utilities for extracting chunk timestamps from memory and session files.
 */

const DATE_FILENAME_RE = /(\d{4}-\d{2}-\d{2})/;

/**
 * Parse an ISO 8601 datetime string to epoch milliseconds.
 * If no timezone is specified, assumes UTC.
 */
export function parseISO8601ToEpochMs(iso: string): number | undefined {
  if (!iso) {
    return undefined;
  }
  // If no timezone offset is present, append "Z" to treat as UTC
  const normalized = /[Zz]|[+-]\d{2}:?\d{0,2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    return undefined;
  }
  return d.getTime();
}

/**
 * Extract a chunk timestamp for a memory file entry.
 * - Dated files (memory/YYYY-MM-DD.md): start of that day in UTC
 * - Non-dated files (MEMORY.md, memory/projects.md): use file mtime
 */
export async function getMemoryChunkTime(entry: {
  relPath?: string;
  absPath?: string;
  mtimeMs?: number;
}): Promise<number | null> {
  const path = entry.relPath ?? entry.absPath ?? "";
  const match = path.match(DATE_FILENAME_RE);
  if (match) {
    const d = new Date(`${match[1]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      return d.getTime();
    }
  }
  return entry.mtimeMs ? Math.floor(entry.mtimeMs) : null;
}

/**
 * Build a function that extracts the earliest timestamp from JSONL lines
 * within a given line range. Each JSONL line is expected to have a top-level
 * "timestamp" field (ISO 8601 string).
 *
 * @param lines - All lines of the JSONL file content
 * @param fallback - Fallback timestamp if no timestamp found in range
 */
export function buildSessionChunkTimeFn(
  lines: string[],
  fallback: number | null,
): (startLine: number, endLine: number) => number | null {
  return (startLine: number, endLine: number): number | null => {
    // Lines are 1-indexed in chunks
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    for (let i = start; i < end; i++) {
      const line = lines[i];
      if (!line) {
        continue;
      }
      // Fast check before JSON parsing
      if (!line.includes('"timestamp"')) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed.timestamp) {
          const d = new Date(parsed.timestamp);
          if (!Number.isNaN(d.getTime())) {
            return d.getTime();
          }
        }
      } catch {
        // not valid JSON, skip
      }
    }
    return fallback;
  };
}
