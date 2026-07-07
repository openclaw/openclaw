/**
 * Decides how the reply-session initializer should react when the optimistic
 * concurrency commit loses its race (`commitReplySessionInitialization` returns
 * `ok: false`).
 *
 * Root cause (runtime-agnostic): the conflict branch used to allow exactly one
 * stale-snapshot retry and then throw. Because init never completed for that
 * sessionKey, the session wedged permanently for ANY runtime — the store entry
 * was never committed, so every following turn hit the same conflict/throw,
 * completed tool-results had no channel back to the model, and the reply
 * silently returned empty. It survived gateway restarts and only cleared on a
 * fresh session. This was observed on both the native (Anthropic) runtime and
 * the Codex app-server harness.
 *
 * The rollover/timeout paths already self-heal by disposing the session's MCP
 * runtime and running the registered harness `reset` hooks — a runtime-agnostic
 * fan-out where each runtime releases its own lane and clears its stale native
 * thread binding (the Codex harness additionally lets its transcript mirror,
 * `<session>.jsonl.codex-app-server.json`, rebuild). The lost Codex mirror is
 * therefore one runtime-specific casualty, not the true root cause.
 *
 * This helper lets the conflict branch reuse that same recovery once and retry
 * init before failing, so init can complete (which is what actually unwedges the
 * session on every runtime) instead of throwing and leaving it stuck forever. If
 * it still cannot commit after recovery, the caller throws with clear context
 * rather than letting any runtime silently return empty tool-results.
 */
export type ReplyInitConflictAction =
  | { kind: "stale-snapshot-retry" }
  | { kind: "self-heal-retry" }
  | { kind: "fail" };

export function resolveReplyInitConflictAction(params: {
  staleSnapshotRetried: boolean;
  conflictRecoveryAttempted: boolean;
}): ReplyInitConflictAction {
  // First conflict: re-read the store snapshot and retry the commit once. This
  // resolves the common benign case where a concurrent same-session turn bumped
  // the revision between our read and our commit.
  if (!params.staleSnapshotRetried) {
    return { kind: "stale-snapshot-retry" };
  }
  // Stale-snapshot retry is exhausted. Before giving up, run the harness
  // self-heal (release the lane / clear the stale native thread binding) exactly
  // once and retry initialization, so a wedged Codex mirror can be rebuilt.
  if (!params.conflictRecoveryAttempted) {
    return { kind: "self-heal-retry" };
  }
  // Recovery already ran and we still cannot commit: surface a clear error rather
  // than leaving the session able to silently return empty tool-results.
  return { kind: "fail" };
}
