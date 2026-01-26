/**
 * Command History — localStorage-backed recents tracking for the command palette.
 *
 * Records command IDs when they are executed and returns them in
 * most-recently-used order.  History is capped at {@link MAX_HISTORY}
 * entries and survives page reloads via localStorage.
 */

const STORAGE_KEY = "clawdbot:command-history";

/** Maximum number of recent command IDs to retain. */
export const MAX_HISTORY = 10;

// ---------------------------------------------------------------------------
// Storage helpers (gracefully degrade when localStorage is unavailable)
// ---------------------------------------------------------------------------

function readStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function writeStorage(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage may be unavailable (private browsing, quota exceeded, etc.)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a command execution.  The command moves to the front of the
 * recents list; duplicates are removed so each ID appears at most once.
 */
export function recordCommandUsage(commandId: string): void {
  const history = readStorage();
  const deduped = history.filter((id) => id !== commandId);
  const updated = [commandId, ...deduped].slice(0, MAX_HISTORY);
  writeStorage(updated);
}

/**
 * Return the most-recently-used command IDs (newest first).
 * @param limit — maximum entries to return (defaults to {@link MAX_HISTORY})
 */
export function getRecentCommandIds(limit: number = MAX_HISTORY): string[] {
  return readStorage().slice(0, limit);
}

/**
 * Clear all command history.
 */
export function clearCommandHistory(): void {
  writeStorage([]);
}
