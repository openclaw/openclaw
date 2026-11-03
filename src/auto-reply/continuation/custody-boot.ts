// Gateway boot for continuation custody (RFC docs/design/continue-work-signal-v2.md
// §5.4.4 crash-boundary table, §5.4.6). The order is fixed: custody readiness
// (phase A: the projection from one read), then subagent registry activation,
// then custody recovery (phase B). Phase A also runs on demand under the first
// custody mutation, so a turn admitted before this boot runs reads committed
// custody.
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { reapOrphanedContinuationCustody } from "./custody-orphan-reaper.js";
import { pruneContinuationRecords, whenContinuationCustodyReady } from "./custody/custody-store.js";

const log = createSubsystemLogger("continuation/custody-boot");

/** Terminal records are retained this long unless they still owe a notice (§5.4.6). */
const CONTINUATION_CUSTODY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type ContinuationCustodyBootSummary = {
  pruned: number;
  orphansReaped: number;
  delegates: { sessions: number; dispatched: number; rejected: number };
  awaitingNextCompactionRequeued: number;
  postCompaction: { sessions: number; dispatched: number; failed: number };
  work: {
    sessions: number;
    dispatched: number;
    failed: number;
    reaped: number;
    terminalNotices: number;
  };
};

/** Retention: prune terminal records past the window that owe no notice. */
async function pruneExpiredContinuationCustody(now = Date.now()): Promise<number> {
  const { deletedRecordIds } = await pruneContinuationRecords({
    endedBefore: now - CONTINUATION_CUSTODY_RETENTION_MS,
  });
  return deletedRecordIds.length;
}

/**
 * Periodic custody upkeep: prune expired terminal records, then fail queued
 * records nothing will dispatch (#1469). Reaped records become terminal, so
 * the next pass prunes them once retention expires. `aliveSince` is the boot
 * cutoff, so time the Gateway was down never counts as overdue.
 */
export async function maintainContinuationCustody(params: {
  aliveSince: number;
  now?: number;
}): Promise<{ pruned: number; orphansReaped: number }> {
  const now = params.now ?? Date.now();
  const pruned = await pruneExpiredContinuationCustody(now);
  const { reaped } = await reapOrphanedContinuationCustody({ aliveSince: params.aliveSince, now });
  return { pruned, orphansReaped: reaped };
}

/**
 * Run continuation custody recovery for one Gateway boot.
 *
 * `armedAt` is the boot-time cutoff captured before any live dispatch could
 * claim a record: only records claimed at or before it belonged to the
 * previous process.
 */
export async function runContinuationCustodyBoot(params: {
  armedAt: number;
  whenSubagentRegistryActivated: () => Promise<void>;
  /**
   * Runs one custody step under the caller's work admission. The registry
   * activation wait is deliberately outside it, so an activation that never
   * comes cannot hold an admission open.
   */
  admit?: <T>(step: () => Promise<T>) => Promise<T>;
}): Promise<ContinuationCustodyBootSummary> {
  const admit = params.admit ?? (<T>(step: () => Promise<T>) => step());
  // 1. Phase A: hydrate the projection from one committed read, unless a
  //    custody mutation already ran it.
  await admit(() => whenContinuationCustodyReady());
  // 2. Registry activation settles delegates an earlier lifecycle left running first.
  await params.whenSubagentRegistryActivated();
  // 3. Phase B: custody recovery. It never re-hydrates: phase A's projection
  //    has been kept current by every commit since, and a late re-read would
  //    overwrite newer committed facts.
  return await admit(() => recoverContinuationCustody(params.armedAt));
}

async function recoverContinuationCustody(
  armedAt: number,
): Promise<ContinuationCustodyBootSummary> {
  await whenContinuationCustodyReady();
  const [delegateRecovery, workModule, workAuthority] = await Promise.all([
    import("./delegate-dispatch-recovery.js"),
    import("./work-dispatch.js"),
    import("./work-recipient-authority.js"),
  ]);
  // Delegate recovery runs before same-session work recovery to preserve the
  // normal post-turn order when both were queued in the same turn.
  const delegates = await delegateRecovery.recoverPendingContinuationDelegates({
    queuedCreatedAtOrBefore: armedAt,
    includeRunningUpdatedAtOrBefore: armedAt,
  });
  const { requeued: awaitingNextCompactionRequeued } =
    await delegateRecovery.requeueAwaitingNextCompactionDelegates({
      runningUpdatedAtOrBefore: armedAt,
    });
  const postCompaction = await delegateRecovery.recoverAndReleaseStagedPostCompactionDelegates({
    runningUpdatedAtOrBefore: armedAt,
  });
  // The replay boundary: a kept wake whose recipient authority moved while the Gateway was down is
  // refused before recovery can drive it. A failed sweep costs only its early refusal: the
  // dispatcher's handoff checks each wake again before it runs.
  try {
    await workAuthority.refuseStaleContinuationWorkAtReplay();
  } catch (err) {
    log.warn(`[continuation:work-replay-refusal-failed] error=${formatErrorMessage(err)}`);
  }
  const work = await workModule.recoverPendingContinuationWork();
  // Upkeep runs after recovery: the backlog recovery dispatches after an
  // outage is not orphaned. What is left (a missing owner, or a row nothing
  // took) is reaped here. Upkeep is best effort: a failed sweep is logged and
  // costs the boot nothing.
  let upkeep = { pruned: 0, orphansReaped: 0 };
  try {
    upkeep = await maintainContinuationCustody({ aliveSince: armedAt });
  } catch (err) {
    log.warn(`[continuation:custody-upkeep-failed] error=${formatErrorMessage(err)}`);
  }
  const { pruned, orphansReaped } = upkeep;
  return {
    pruned,
    orphansReaped,
    delegates,
    awaitingNextCompactionRequeued,
    postCompaction,
    work,
  };
}
