/**
 * Decides how the reply-session initializer should react when the optimistic
 * concurrency commit loses its race (`commitReplySessionInitialization` returns
 * `ok: false`).
 *
 * The conflict branch used to allow exactly one stale-snapshot retry and then
 * throw. Because init never completed for that sessionKey, the session wedged
 * permanently for ANY runtime — the store entry was never committed, so every
 * following turn hit the same conflict/throw, completed tool-results had no
 * channel back to the model, and the reply silently returned empty.
 *
 * This helper lets the conflict branch reuse the rollover/timeout self-heal
 * (dispose the session's MCP runtime + run harness reset hooks) once before
 * throwing, so init can complete and unwedge the session.
 */
export type ReplyInitConflictAction =
  | { kind: "stale-snapshot-retry" }
  | { kind: "self-heal-retry" }
  | { kind: "fail" };

export function resolveReplyInitConflictAction(params: {
  staleSnapshotRetried: boolean;
  conflictRecoveryAttempted: boolean;
}): ReplyInitConflictAction {
  // First conflict: re-read the store snapshot and retry the commit once.
  // This resolves the common benign case where a concurrent same-session
  // turn bumped the revision between our read and our commit.
  if (!params.staleSnapshotRetried) {
    return { kind: "stale-snapshot-retry" };
  }
  // Stale-snapshot retry is exhausted. Before giving up, run the harness
  // self-heal (release the lane / clear the stale native thread binding)
  // exactly once and retry initialization, so a wedged runtime can recover.
  if (!params.conflictRecoveryAttempted) {
    return { kind: "self-heal-retry" };
  }
  // Recovery already ran and we still cannot commit: surface a clear error
  // rather than leaving the session able to silently return empty tool-results.
  return { kind: "fail" };
}
