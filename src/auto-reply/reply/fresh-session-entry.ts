import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";

/**
 * Live-test iteration 2 Bug A: distilled "what's the live planMode mode?"
 * lookup — encodes the SEMANTIC that an absent `planMode` object on
 * disk means the session is in NORMAL mode (because `sessions-patch.ts`
 * DELETES planMode entirely on `approve`/`edit` when no `autoApprove`
 * flag is preserved). Returns:
 *
 * - `"plan"` when `liveEntry.planMode.mode === "plan"`
 * - `"normal"` when `liveEntry.planMode.mode === "normal"` OR when
 *   the entry exists but planMode is missing (deletion = normal mode)
 * - `undefined` ONLY when we have no live entry to inspect (missing
 *   storePath/sessionKey, disk error, or sessionKey not in store)
 *
 * This `undefined` semantic is critical: callers that fall back to a
 * cached snapshot (`getLatestPlanMode() ?? cached`) MUST treat
 * undefined as "couldn't read disk, prefer cache" — NOT as "planMode
 * was deleted." Returning `"normal"` on deletion makes the caller use
 * the FRESH disk fact instead of falling back to a stale "plan"
 * snapshot, which was the root cause of mutation-gate-blocks-after-
 * approval and ack-only-fires-after-approval (Bug A iter-2).
 */
export type LivePlanMode = "plan" | "normal";

export function resolveLatestPlanModeFromDisk(params: {
  storePath?: string;
  sessionKey?: string;
}): LivePlanMode | undefined {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return undefined;
  }
  try {
    const liveStore = loadSessionStore(storePath, { skipCache: true });
    const liveEntry = liveStore?.[sessionKey];
    if (!liveEntry) {
      return undefined;
    }
    const mode = liveEntry.planMode?.mode;
    if (mode === "plan") {
      return "plan";
    }
    // mode === "normal" OR planMode object deleted (post-approval).
    // Per the deletion-as-normal contract documented above, both
    // collapse to "normal" so consumers don't false-positive on a
    // stale "plan" cached snapshot.
    return "normal";
  } catch {
    return undefined;
  }
}

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
