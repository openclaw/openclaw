import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// Copilot review #68939 (round-1): use the structured subsystem
// logger instead of console.warn so operators can route/filter the
// "unknown planMode.mode" diagnostic uniformly with every other
// fresh-disk-read warning. Lives at module scope so the helper
// function below doesn't have to construct a new logger per call.
const log = createSubsystemLogger("auto-reply/fresh-session-entry");

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
export type LivePlanMode = "plan" | "executing" | "normal";

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
    if (mode === "executing") {
      // PR #68939 follow-up — new "executing" state for post-approval
      // execution phase. The mutation gate (the primary consumer of
      // this helper) treats "executing" the same as "normal"
      // (mutations allowed). New consumers like the execution-phase
      // nudge cron + UI chip rendering use the distinction.
      return "executing";
    }
    if (mode === "normal" || mode === undefined) {
      // mode === "normal" OR planMode object deleted (post-approval).
      // Per the deletion-as-normal contract documented above, both
      // collapse to "normal" so consumers don't false-positive on a
      // stale "plan" cached snapshot.
      return "normal";
    }
    // Copilot review #68939 (2026-04-19): unrecognized / forward-
    // compat / corrupt mode values now return `undefined` (not
    // "normal") so the caller falls back to the cached snapshot
    // chain. Previously this collapsed to "normal" — that's a
    // FAIL-OPEN behavior that would unintentionally unlock
    // mutation tools when on-disk state is malformed (corruption
    // or partial write). The new fallback chain in
    // `pi-tools.before-tool-call.ts:234-235` is
    // `liveMode !== undefined ? liveMode : args.ctx?.planMode` —
    // returning undefined here lets it use the in-memory cached
    // snapshot, which preserves both:
    //   - SECURITY: if the session was in plan mode pre-corruption,
    //     the cached snapshot is "plan" so the mutation gate stays
    //     armed (no fail-open).
    //   - RECOVERY: if the session was in normal mode, the cached
    //     snapshot is "normal" so the user isn't locked out.
    // Operators see the warn-log so they can investigate +
    // manually correct the corrupt entry. The previous test
    // contract (fresh-session-entry.test.ts:294-306) is updated
    // alongside this change.
    // Copilot review #68939 (round-1): switched from console.warn
    // to the subsystem logger so the diagnostic threads through the
    // standard log routing/filter pipeline with structured fields.
    log.warn(
      `resolveLatestPlanModeFromDisk: unknown planMode.mode value=${JSON.stringify(mode)} sessionKey=${sessionKey} (returning undefined so caller falls back to cached snapshot — safer than fail-open-to-normal)`,
    );
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the live `acceptEdits` permission flag for a session,
 * bypassing the in-memory store cache so a recent `sessions.patch`
 * approve-with-edits action is visible on the very next tool call.
 *
 * Returns `true` only when `postApprovalPermissions.acceptEdits ===
 * true`. Any other state (no permission object, explicit false, or
 * disk unreadable) returns `false` so the constraint gate defaults
 * to "permission not granted" — callers should treat this as a
 * conservative fail-closed read of the permission, while the gate
 * itself (applied only when this returns true) is fail-open per
 * `accept-edits-gate.ts`.
 */
export function resolveLatestAcceptEditsFromDisk(params: {
  storePath?: string;
  sessionKey?: string;
}): boolean {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return false;
  }
  try {
    const liveStore = loadSessionStore(storePath, { skipCache: true });
    const liveEntry = liveStore?.[sessionKey];
    return liveEntry?.postApprovalPermissions?.acceptEdits === true;
  } catch {
    return false;
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
