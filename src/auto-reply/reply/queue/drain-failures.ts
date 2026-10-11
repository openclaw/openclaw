import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import type { FollowupRun } from "./types.js";

// Failures belong to attempted source identities, not session keys or whichever
// item becomes the head while delivery awaits. Retry clones share the identity;
// queue replacement starts a fresh budget and weak keys retain no cleared work.
export type FollowupDrainFailure = { queue: object; failures: number };

export const FOLLOWUP_DRAIN_FAILURES = resolveGlobalSingleton(
  Symbol.for("openclaw.followupDrainFailures"),
  () => new WeakMap<FollowupRun, FollowupDrainFailure>(),
);

/**
 * Overflow compaction replaces a retained source with a fresh object, on both
 * the enqueue and the drain side. The clone is the same accepted work, so it
 * must keep spending the source's retry budget instead of starting over.
 */
export function carryFollowupDrainFailure(source: FollowupRun, clone: FollowupRun): void {
  const failure = FOLLOWUP_DRAIN_FAILURES.get(source);
  if (failure) {
    FOLLOWUP_DRAIN_FAILURES.set(clone, failure);
  }
}
