// Guard 2 of durable continue_work dispatch: a matured drain batch folds its stale backlog into the
// newest election. Pure, so the dispatcher's partition is testable on its own.
import type { PendingContinuationWork } from "./work-flow-state.js";

/**
 * Guard 2 — partition a matured drain batch into works to drive vs works
 * superseded by a stale backlog.
 *
 * `consumePendingWork` only returns matured (`now >= dueAt`) works, so a batch of
 * >1 is itself the backlog signal: on-time staggered elections fire one-per-poll
 * and never co-drain. Within such a batch we fold the OLDER members that are
 * stale (overdue past `graceMs`) into the newest-elected member, which carries
 * the live intent. Non-stale members (close bursts) always drive; the
 * newest-elected always drives.
 *
 * -1 fold-side write-guard: only `queued` members are supersede-eligible.
 * A recovered `running` member (the recovery path passes `includeRunning`) is a
 * live turn already being driven and ALWAYS drives — it is never folded, even
 * when stale and not newest, so an in-flight turn is never finished-as-superseded
 * out from under itself. Pure for testability.
 */
export function partitionSupersededWork(
  works: readonly PendingContinuationWork[],
  graceMs: number,
  now: number,
): { drive: PendingContinuationWork[]; superseded: PendingContinuationWork[] } {
  if (works.length <= 1 || graceMs <= 0) {
    return { drive: [...works], superseded: [] };
  }
  // Identify the single newest-elected member. A synchronous batch enqueue can
  // stamp identical `electedAt` (the store writes are sync), so ties are broken
  // by `hop` (durable monotonic enqueue order within a chain) — the higher hop
  // is the newer intent. Without the tie-break, same-ms rows fall to array
  // order and the OLDEST stale wake could be kept while the newest is folded
  // (review).
  let newestIdx = 0;
  let newest: PendingContinuationWork | undefined;
  for (const [i, work] of works.entries()) {
    if (
      !newest ||
      work.electedAt > newest.electedAt ||
      (work.electedAt === newest.electedAt && work.hop > newest.hop)
    ) {
      newestIdx = i;
      newest = work;
    }
  }
  const drive: PendingContinuationWork[] = [];
  const superseded: PendingContinuationWork[] = [];
  for (const [i, work] of works.entries()) {
    // -1 fold-side write-guard: a recovered `running` member is live
    // intent already being driven (it may be observing requests-in-flight). It
    // is NEVER supersede-eligible, regardless of staleness or election order —
    // folding it would finish an in-flight turn as superseded out from under
    // itself. Only `queued` backlog members can be coalesced into the newest.
    if (work.status === "running") {
      drive.push(work);
      continue;
    }
    const isNewest = i === newestIdx;
    const isStale = now - work.dueAt > graceMs;
    if (isNewest) {
      // The single newest-elected member always drives (live intent).
      drive.push(work);
    } else if (isStale) {
      superseded.push(work);
    } else {
      drive.push(work);
    }
  }
  return { drive, superseded };
}
