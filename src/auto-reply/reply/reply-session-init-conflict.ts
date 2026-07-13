/**
 * Decides how the reply-session initializer should react when the optimistic
 * concurrency commit loses its race (`commitReplySessionInitialization` returns
 * `ok: false`).
 *
 * Root cause (runtime-agnostic BY CONSTRUCTION): the conflict lives in the
 * session-store optimistic-commit path (`commitReplySessionInitialization`),
 * which sits ABOVE any model runtime — so the wedge cannot be runtime-specific.
 * The conflict branch used to allow exactly one stale-snapshot retry and then
 * throw. Because init never completed for that sessionKey, the session wedged
 * permanently for ANY runtime — the store entry was never committed, so every
 * following turn hit the same conflict/throw, completed tool-results had no
 * channel back to the model, and the reply silently returned empty. It survived
 * gateway restarts and only cleared on a fresh session. Every case we actually
 * observed ran under the codex app-server harness (the agent runs codex even on
 * Anthropic models); we did not independently observe it on the native runtime,
 * but the store-level location means it is not codex-specific.
 *
 * This is the reply-session analogue of the ACP-harness init conflict fixed in
 * #98931 (closed): that change established this same dispose-runtime + harness-
 * reset recovery path for a session-store commit conflict, which this reuses for
 * the reply-session initializer.
 *
 * The rollover/timeout paths already self-heal by disposing the session's MCP
 * runtime and running the registered harness `reset` hooks — a runtime-agnostic
 * fan-out where each runtime releases its own lane and clears its stale native
 * thread binding (the Codex harness additionally lets its transcript mirror,
 * `<session>.jsonl.codex-app-server.json`, rebuild). The lost Codex mirror is
 * therefore one runtime-specific casualty, not the true root cause.
 *
 * Layering with the #105754 backoff (#102400): transient CAS races are handled
 * FIRST by `runWithSessionInitConflictRetry`, which retries the whole unlocked
 * init attempt with jittered exponential backoff. While that loop is still
 * live (`selfHealRequested=false`), a repeated conflict propagates as the typed
 * `ReplySessionInitConflictError` (`conflict-backoff`) so the backoff owns the
 * retry. Only after the backoff EXHAUSTS does `initSessionState` re-enter the
 * attempt with `selfHealRequested=true`, unlocking the self-heal path below —
 * because a conflict that survives five backed-off fresh-snapshot attempts is a
 * persistent wedge, not a race.
 *
 * This helper lets the conflict branch reuse that same recovery once and retry
 * init before failing, so init can complete (which is what actually unwedges the
 * session on every runtime) instead of throwing and leaving it stuck forever. If
 * it still cannot commit after recovery, the caller throws with clear context
 * rather than letting any runtime silently return empty tool-results.
 */
export type ReplyInitConflictAction =
  | { kind: "stale-snapshot-retry" }
  | { kind: "conflict-backoff" }
  | { kind: "self-heal-retry" }
  | { kind: "fail" };

/**
 * Conflict-recovery progress threaded through the locked init attempts.
 * `selfHealRequested` is true only on the post-backoff-exhaustion pass;
 * `recoveryAttempted` is true only after the fenced teardown already ran once.
 */
export type ReplyInitConflictRecoveryState = {
  selfHealRequested: boolean;
  recoveryAttempted: boolean;
};

export function resolveReplyInitConflictAction(params: {
  staleSnapshotRetried: boolean;
  selfHealRequested: boolean;
  conflictRecoveryAttempted: boolean;
}): ReplyInitConflictAction {
  // First conflict: re-read the store snapshot and retry the commit once. This
  // resolves the common benign case where a concurrent same-session turn bumped
  // the revision between our read and our commit.
  if (!params.staleSnapshotRetried) {
    return { kind: "stale-snapshot-retry" };
  }
  // The backoff loop has not exhausted yet: surface the typed conflict so the
  // unlocked jittered backoff (#105754) retries with a fresh snapshot before any
  // teardown is considered. Transient races settle here without side effects.
  if (!params.selfHealRequested) {
    return { kind: "conflict-backoff" };
  }
  // Backoff exhausted. Before giving up, run the harness self-heal (release the
  // lane / clear the stale native thread binding) exactly once and retry
  // initialization, so a wedged Codex mirror can be rebuilt.
  if (!params.conflictRecoveryAttempted) {
    return { kind: "self-heal-retry" };
  }
  // Recovery already ran and we still cannot commit: surface a clear error rather
  // than leaving the session able to silently return empty tool-results.
  return { kind: "fail" };
}
