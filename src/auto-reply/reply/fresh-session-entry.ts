import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";

/**
 * Bug 3+4 v3 helper: read the LATEST persisted SessionEntry for a
 * given sessionKey, bypassing the in-memory session-store cache.
 *
 * # Why this exists
 *
 * `params.getActiveSessionEntry()` in the agent-runner pipeline (see
 * `agent-runner.ts:1207`) is a closure over a `let activeSessionEntry`
 * captured at run-start (line 921). That captured ref only refreshes
 * at compaction / memory flush / explicit error-recovery checkpoints,
 * NOT mid-turn. So a `sessions.patch` write — for example a UI plan
 * approval that flips `planMode.mode → "normal"` between two tool
 * calls in the same run — lands invisible to any downstream snapshot
 * or callback that reads through the closure.
 *
 * `loadSessionStore(storePath, { skipCache: true })` bypasses the
 * module-level cache and reads the persisted JSON directly. Disk I/O
 * is acceptable for the call sites that use this helper:
 * - small file (typical session store < 10 KB)
 * - OS page cache makes repeated reads ~microseconds
 * - call cadence is at most per-tool-call (1-5 s LLM turns)
 *
 * # Fallback semantics
 *
 * Returns `fallbackEntry` (typically the closure value) when:
 * - `storePath` or `sessionKey` is missing (test path / in-memory run)
 * - `loadSessionStore` throws (corrupt JSON, EACCES, etc.)
 * - The store has no entry for the key
 *
 * This makes the helper a pure superset of the closure path — it never
 * returns LESS info than the fallback would.
 */
export function readLatestSessionEntryFresh(params: {
  storePath?: string;
  sessionKey?: string;
  fallbackEntry?: SessionEntry;
}): SessionEntry | undefined {
  const { storePath, sessionKey, fallbackEntry } = params;
  if (!storePath || !sessionKey) {
    return fallbackEntry;
  }
  try {
    const liveStore = loadSessionStore(storePath, { skipCache: true });
    return liveStore?.[sessionKey] ?? fallbackEntry;
  } catch {
    return fallbackEntry;
  }
}
