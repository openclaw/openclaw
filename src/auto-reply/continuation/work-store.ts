/**
 * Durable continue_work store over the continuation custody store (RFC
 * docs/design/continue-work-signal-v2.md §5.4.2).
 *
 * `continue_work` elects another turn in the same session. The volatile timer is
 * only a maturity wake; the election itself is a custody `work` record, so a
 * Gateway restart can re-arm it and subagent cleanup can retain the session
 * until the wake is delivered.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readContinuationLiveWork } from "./custody/custody-projection.js";
import {
  listContinuationRecords,
  resolveContinuationCustodyDatabasePath,
  updateContinuationRecords,
} from "./custody/custody-store.js";
import type {
  ContinuationRecord,
  ContinuationRecordPatch,
  ContinuationUpdateResult,
} from "./custody/custody-store.types.js";
import {
  buildFallbackWorkState,
  decodeWorkState,
  isContinuationWorkFlow,
  workRecordDueAt,
  workToRuntime,
  type PendingContinuationIdleRetry,
  type PendingContinuationWork,
  type PendingWorkState,
} from "./work-flow-state.js";
import { buildFinishedWorkPatch } from "./work-replacement-store.js";

const log = createSubsystemLogger("continuation/work-store");

type PendingWorkDeliveryCommitResult = Readonly<
  | { applied: true; work: PendingContinuationWork }
  | { applied: false; work: PendingContinuationWork }
>;

type ContinuationWorkTurnFenceResult =
  | { allowed: true; work: PendingContinuationWork }
  | { allowed: false; reason: "cancelled" | "stale" };

/** The stable failure reason of a wake whose turn started but whose delivery was never confirmed. */
const WORK_TURN_INTERRUPTED_REASON = "turn-started-delivery-unconfirmed";

async function readWorkRecord(recordId: string): Promise<ContinuationRecord | undefined> {
  const record = (await listContinuationRecords({ recordIds: [recordId], kinds: ["work"] }))[0];
  return record && isContinuationWorkFlow(record) ? record : undefined;
}

async function listOwnerWorkRecords(
  sessionKey: string,
  statuses?: readonly ("queued" | "running" | "failed")[],
): Promise<ContinuationRecord[]> {
  return await listContinuationRecords({
    ownerSessionKey: sessionKey,
    kinds: ["work"],
    ...(statuses ? { statuses } : {}),
  });
}

/** One revision CAS on a work record. */
async function writeWork(
  record: Pick<ContinuationRecord, "recordId" | "ownerSessionKey">,
  expectedRevision: number,
  patch: ContinuationRecordPatch,
  now = Date.now(),
): Promise<ContinuationUpdateResult> {
  return await updateContinuationRecords(
    [
      {
        recordId: record.recordId,
        ownerSessionKey: record.ownerSessionKey,
        expectedRevision,
        patch,
      },
    ],
    { now },
  );
}

function appliedRecord(result: ContinuationUpdateResult): ContinuationRecord | undefined {
  return result.outcome === "applied" ? result.records[0] : undefined;
}

/** State JSON plus its derived due-time column (RFC §5.4.2, `due_at`). */
function statePatch(state: PendingWorkState): Pick<ContinuationRecordPatch, "stateJson" | "dueAt"> {
  return { stateJson: JSON.stringify(state), dueAt: workRecordDueAt(state) };
}

/**
 * The durable turn-start fence, the final boundary before a claimed wake's turn may run (RFC
 * §5.4.2, at-most-once through a crash). One revision CAS on the claimed record writes `turnStart`
 * under the run id the turn will run with; only a committed fence lets the turn start, and recovery
 * never drives a fenced record again. A record that moved, ended or is cancel-fenced refuses it.
 */
export async function markPendingWorkTurnStarted(
  work: PendingContinuationWork,
  runId: string,
): Promise<ContinuationWorkTurnFenceResult> {
  if (!work.flowId || work.expectedRevision === undefined) {
    return { allowed: false, reason: "stale" };
  }
  const record = await readWorkRecord(work.flowId);
  if (
    !record ||
    record.status !== "running" ||
    record.revision !== work.expectedRevision ||
    record.cancelRequestedAt !== undefined
  ) {
    return {
      allowed: false,
      reason:
        record?.status === "cancelled" || record?.cancelRequestedAt !== undefined
          ? "cancelled"
          : "stale",
    };
  }
  const turnStart = { startedAt: Date.now(), runId };
  const state = { ...(decodeWorkState(record) ?? buildFallbackWorkState(work)), turnStart };
  const fenced = appliedRecord(
    await writeWork(
      record,
      record.revision,
      {
        phase: "Continuation turn started (durable fence)",
        stateJson: JSON.stringify(state),
        updatedAt: turnStart.startedAt,
      },
      turnStart.startedAt,
    ),
  );
  if (!fenced) {
    log.warn(
      `[continuation:work-turn-fence-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
    return { allowed: false, reason: "stale" };
  }
  return { allowed: true, work: { ...work, turnStart, expectedRevision: fenced.revision } };
}

/**
 * Fail a fenced, undelivered record as interrupted (RFC §5.4.2): its turn may have committed
 * effects, so it never runs again, and the same CAS records the one notice its session is owed.
 * The work kind's obligation value is `retry-exhausted` (the column's CHECK admits no other for
 * work); the failure reason selects the interrupted notice. A lost CAS means another pass did it.
 */
async function interruptStartedWorkRecord(
  record: ContinuationRecord,
): Promise<PendingContinuationWork | undefined> {
  const interrupted = appliedRecord(
    await writeWork(record, record.revision, {
      status: "failed",
      phase: "Continuation turn interrupted: started, delivery never confirmed",
      failureReason: WORK_TURN_INTERRUPTED_REASON,
      terminalNoticePending: "retry-exhausted",
    }),
  );
  return interrupted ? toNoticeWork(interrupted) : undefined;
}

async function finalizeDeliveredWorkRecord(
  record: ContinuationRecord,
  state: PendingWorkState,
): Promise<void> {
  const now = Date.now();
  const foldedActive = state.disposition === "folded-active";
  const { recoveryDueAt: _recoveryDueAt, ...terminalState } = state;
  const finished = await writeWork(
    record,
    record.revision,
    {
      status: "succeeded",
      phase: foldedActive
        ? "folded-into-active-turn: recovered delivered fold note"
        : "Same-session continuation turn granted",
      failureReason: null,
      stateJson: JSON.stringify({
        ...terminalState,
        ...(foldedActive
          ? { foldedAt: state.foldedAt ?? now }
          : {
              deliveredAt: state.deliveredAt ?? now,
              turnGrantedAt: state.turnGrantedAt ?? state.deliveredAt ?? now,
            }),
        disposition: state.disposition ?? (foldedActive ? "folded-active" : "granted"),
        busySkipCount: 0,
      }),
      updatedAt: now,
    },
    now,
  );
  if (finished.outcome !== "applied") {
    log.warn(
      `[continuation:work-delivered-finish-not-committed] flowId=${record.recordId} expectedRevision=${record.revision}`,
    );
  }
}

export async function listPendingWorkSessionKeysForRecovery(): Promise<string[]> {
  const keys = (
    await listContinuationRecords({ kinds: ["work"], statuses: ["queued", "running"] })
  ).map((record) => record.ownerSessionKey);
  return [...new Set(keys)].toSorted();
}

export async function consumePendingWork(
  sessionKey: string,
  options: {
    includeRunning?: boolean;
    includeRunningUpdatedAtOrBefore?: number;
    includeIdleRetry?: boolean;
    includeRunningIdleRetry?: boolean;
    /** Receives each record this pass interrupted; handing off its owed notice is the caller's. */
    onInterrupted?: (work: PendingContinuationWork) => void;
  } = {},
): Promise<PendingContinuationWork[]> {
  const now = Date.now();
  const work: PendingContinuationWork[] = [];
  for (const record of await listOwnerWorkRecords(sessionKey, ["queued", "running"])) {
    // A cancel-fenced record is terminating: never consume or drive it, so a
    // cancelled wake is never granted a turn out from under the cancel.
    if (record.cancelRequestedAt !== undefined) {
      continue;
    }
    const state = decodeWorkState(record);
    if (!state) {
      log.warn(
        `[continuation:work-decode-failed] flowId=${record.recordId} session=${sessionKey} stateBytes=${record.stateJson.length}`,
      );
      await writeWork(record, record.revision, {
        status: "failed",
        phase: "Rejected invalid continuation work payload",
        failureReason: "Pending continuation work payload could not be decoded.",
      });
      continue;
    }
    // locus-3 read-guard: a durably delivered-marked record was confirmed
    // delivered before the persist-gap. Even if it is still `running` (the
    // process died after the durable mark but before the finish), never
    // re-consume it: that would be a restart-gap double delivery.
    if (state.succeeded) {
      await finalizeDeliveredWorkRecord(record, state);
      continue;
    }
    if (state.anchorPending === true) {
      continue;
    }
    const canConsumeRunning =
      record.status === "running" &&
      options.includeRunning === true &&
      (options.includeRunningUpdatedAtOrBefore === undefined ||
        record.updatedAt <= options.includeRunningUpdatedAtOrBefore);
    if (record.status !== "queued" && !canConsumeRunning) {
      continue;
    }
    const idleRetryReady =
      state.idleRetry !== undefined &&
      (options.includeIdleRetry === true ||
        (options.includeRunningIdleRetry === true && record.status === "running"));
    if (now < workRecordDueAt(state) && !idleRetryReady) {
      continue;
    }
    // At-most-once (RFC §5.4.2): wherever a pass would drive a record, a durable turn-start fence
    // without the delivered mark means the turn may already have run, so it is interrupted instead.
    // Only a claim with no fence is retried.
    if (state.turnStart) {
      const interrupted = await interruptStartedWorkRecord(record);
      if (interrupted) {
        log.warn(
          `[continuation:work-turn-interrupted] flowId=${record.recordId} session=${sessionKey} runId=${state.turnStart.runId} startedAt=${state.turnStart.startedAt}`,
        );
        options.onInterrupted?.(interrupted);
      }
      continue;
    }
    const releasedAt = Date.now();
    const nextState = { ...state, releasedAt };
    const claimed = appliedRecord(
      await writeWork(
        record,
        record.revision,
        {
          status: "running",
          phase:
            record.status === "running"
              ? "Re-driving same-session continuation wake"
              : "Released to continuation wake scheduler",
          failureReason: null,
          ...statePatch(nextState),
          updatedAt: releasedAt,
        },
        releasedAt,
      ),
    );
    if (!claimed) {
      continue;
    }
    // Carry the PRE-claim durable status: the claim flips every consumed
    // record to `running`, so the claimed record can no longer tell a
    // recovered active turn from freshly released queued backlog. The
    // fold-side write-guard keys off this original status.
    const originalStatus: "queued" | "running" = record.status === "running" ? "running" : "queued";
    work.push(workToRuntime(claimed, nextState, originalStatus));
  }
  return work;
}

export async function finalizeAnchorPendingWork(
  sessionKey: string,
  anchorFinalizedAt: number,
  options: { activeSessionId?: string; matureOverdueAnchors?: boolean } = {},
): Promise<number> {
  let anchored = 0;
  for (const record of await listOwnerWorkRecords(sessionKey, ["queued"])) {
    if (record.cancelRequestedAt !== undefined) {
      continue;
    }
    const state = decodeWorkState(record);
    if (!state || state.succeeded || state.anchorPending !== true) {
      continue;
    }
    if (
      options.activeSessionId !== undefined &&
      (state.originTurnId === undefined || state.originTurnId === options.activeSessionId)
    ) {
      continue;
    }
    const effectiveAnchorFinalizedAt =
      options.matureOverdueAnchors === true && anchorFinalizedAt - state.electedAt >= state.delayMs
        ? anchorFinalizedAt - state.delayMs
        : anchorFinalizedAt;
    const {
      anchorPending: _anchorPending,
      idleRetry: _idleRetry,
      recoveryDueAt: _recoveryDueAt,
      ...stateWithoutPending
    } = state;
    const dueAt = effectiveAnchorFinalizedAt + state.delayMs;
    // Anchoring sets `updated_at` to the anchor time on purpose (§5.4.2).
    const updated = await writeWork(record, record.revision, {
      phase: "Anchored same-session continuation wake to electing turn finalization",
      ...statePatch({
        ...stateWithoutPending,
        dueAt,
        anchorFinalizedAt: effectiveAnchorFinalizedAt,
      }),
      updatedAt: effectiveAnchorFinalizedAt,
    });
    if (updated.outcome === "applied") {
      anchored++;
    } else {
      log.warn(
        `[continuation:work-anchor-not-committed] flowId=${record.recordId} expectedRevision=${record.revision}`,
      );
    }
  }
  return anchored;
}

function ownerOf(work: PendingContinuationWork, flowId: string) {
  return { recordId: flowId, ownerSessionKey: work.sessionKey };
}

/**
 * Finish a continuation-work record cleanly (terminal, no failure or retry).
 *
 * Shared by the turn-granted, superseded, and orphan-reaped paths: each is an
 * INTENTIONAL terminal (the wake will not re-arm), distinct from
 * {@link markPendingWorkFailed}. `stateExtra` carries the path-specific
 * durable state; `turnGrantedAt` is always stamped so the record reads as
 * delivered or closed downstream.
 */
async function finishContinuationWorkRecord(
  work: PendingContinuationWork,
  params: { phase: string; stateExtra?: Record<string, unknown>; notCommittedTag: string },
): Promise<boolean> {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = await readWorkRecord(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const now = Date.now();
  const patch = buildFinishedWorkPatch(state ?? buildFallbackWorkState(work), {
    phase: params.phase,
    ...(params.stateExtra ? { stateExtra: params.stateExtra } : {}),
    now,
  });
  const finished = await writeWork(ownerOf(work, work.flowId), work.expectedRevision, patch, now);
  if (finished.outcome !== "applied") {
    log.warn(
      `[continuation:${params.notCommittedTag}] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
  }
  return finished.outcome === "applied";
}

export async function markPendingWorkTurnGranted(work: PendingContinuationWork): Promise<boolean> {
  return await finishContinuationWorkRecord(work, {
    phase: "Same-session continuation turn granted",
    // A record that drove is no longer busy-deferred; clear the busy counter
    // so the granted record never carries stale retry state.
    stateExtra: { busySkipCount: 0 },
    notCommittedTag: "work-finish-not-committed",
  });
}

export async function markPendingWorkFolded(
  work: PendingContinuationWork,
  params: { summary: string; foldedAt: number; overdueByMs: number },
): Promise<boolean> {
  return await finishContinuationWorkRecord(work, {
    phase: `folded-into-active-turn: ${params.summary}`.slice(0, 200),
    stateExtra: {
      disposition: "folded-active",
      foldedAt: params.foldedAt,
      overdueByMs: params.overdueByMs,
      busySkipCount: 0,
    },
    notCommittedTag: "work-fold-not-committed",
  });
}

async function writeDeliveredMark(
  work: PendingContinuationWork,
  params: {
    phase: string;
    at: number;
    stateExtra: Partial<PendingWorkState>;
    notCommittedTag: string;
  },
): Promise<PendingWorkDeliveryCommitResult> {
  if (!work.flowId || work.expectedRevision === undefined) {
    return { applied: false, work };
  }
  const current = await readWorkRecord(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const succeeded = { point: "optimal", durability: "durable" } as const;
  const updated = appliedRecord(
    await writeWork(
      ownerOf(work, work.flowId),
      work.expectedRevision,
      {
        phase: params.phase,
        stateJson: JSON.stringify({
          ...(state ?? buildFallbackWorkState(work)),
          ...params.stateExtra,
          succeeded,
        }),
        updatedAt: params.at,
      },
      params.at,
    ),
  );
  if (!updated) {
    log.warn(
      `[continuation:${params.notCommittedTag}] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
    return { applied: false, work };
  }
  return {
    applied: true,
    work: { ...work, ...params.stateExtra, expectedRevision: updated.revision, succeeded },
  };
}

export async function markPendingWorkFoldDelivered(
  work: PendingContinuationWork,
  params: { foldedAt: number; overdueByMs: number },
): Promise<PendingWorkDeliveryCommitResult> {
  return await writeDeliveredMark(work, {
    phase: "Continuation fold note delivered (durable mark)",
    at: params.foldedAt,
    stateExtra: {
      disposition: "folded-active",
      foldedAt: params.foldedAt,
      overdueByMs: params.overdueByMs,
      busySkipCount: 0,
    },
    notCommittedTag: "work-fold-deliver-mark-not-committed",
  });
}

/**
 * Durably mark a continuation wake delivered, BEFORE the persist-gap (locus-3).
 *
 * Written the instant a wake is confirmed delivered (the agent turn ran),
 * before the dispatch loop's follow-on {@link markPendingWorkTurnGranted}
 * finalizes the record. The record stays `running`; only the state's
 * `succeeded` marker is set, so a crash in the deliver-to-finalize window
 * leaves a record the consume read-guard recognizes as delivered. The returned
 * value carries the bumped revision so the follow-on finish still applies.
 * INVARIANT (load-bearing): the mark is durably persisted here; an
 * in-memory-only mark is lost with the process and the gap stays open.
 */
export async function markPendingWorkDelivered(
  work: PendingContinuationWork,
): Promise<PendingWorkDeliveryCommitResult> {
  const now = Date.now();
  return await writeDeliveredMark(work, {
    phase: "Continuation wake delivered (durable mark)",
    at: now,
    stateExtra: { deliveredAt: now, disposition: "granted" },
    notCommittedTag: "work-deliver-mark-not-committed",
  });
}

/**
 * Reconcile a work record whose durable delivered mark lost the revision race
 * after the provider turn already executed. The turn is spent, so restart-gap
 * replay must be prevented AND the record must not linger `running`. Finish the
 * CURRENT-revision record here; if finishing races too, fail it non-retryably:
 * dropping a stale record is strictly safer than replaying an executed turn.
 *
 * No-ops when the record is gone, already terminal, cancel-owned, or requeued
 * by another actor: none of those replay THIS turn.
 */
export async function reconcileUndeliverableGrantedWork(
  work: PendingContinuationWork,
): Promise<void> {
  if (!work.flowId) {
    return;
  }
  const current = await readWorkRecord(work.flowId);
  if (!current || current.status !== "running" || current.cancelRequestedAt !== undefined) {
    return;
  }
  const state = decodeWorkState(current) ?? buildFallbackWorkState(work);
  const { idleRetry: _idleRetry, recoveryDueAt: _recoveryDueAt, ...terminalState } = state;
  const now = Date.now();
  const succeeded = { point: "optimal", durability: "durable" } as const;
  const finished = await writeWork(
    current,
    current.revision,
    {
      status: "succeeded",
      phase: "Continuation wake delivered (post-race reconcile)",
      failureReason: null,
      stateJson: JSON.stringify({
        ...terminalState,
        deliveredAt: state.deliveredAt ?? now,
        turnGrantedAt: now,
        disposition: "granted",
        succeeded,
      }),
      updatedAt: now,
    },
    now,
  );
  if (finished.outcome === "applied") {
    return;
  }
  const latest = await readWorkRecord(work.flowId);
  if (!latest || latest.status !== "running" || latest.cancelRequestedAt !== undefined) {
    return;
  }
  await writeWork(latest, latest.revision, {
    status: "failed",
    phase: "Continuation turn executed; delivered-mark lost revision race",
    failureReason:
      "Provider turn already ran; parking non-retryable to prevent restart-gap replay.",
  });
}

export async function requeuePendingWork(
  work: PendingContinuationWork,
  params: {
    dueAt: number;
    summary: string;
    retryCount?: number;
    busySkipCount?: number;
    idleRetry?: PendingContinuationIdleRetry;
  },
): Promise<boolean> {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = await readWorkRecord(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const baseState: PendingWorkState = state ?? {
    kind: "continuation_work",
    sessionKey: work.sessionKey,
    hop: work.hop,
    delayMs: work.delayMs,
    electedAt: work.electedAt,
    dueAt: work.dueAt,
    maxChainLength: work.maxChainLength,
    ...(work.recipientAuthority ? { recipientAuthority: work.recipientAuthority } : {}),
  };
  // Only a turn that never started is requeued, so the requeue clears its turn-start fence.
  const {
    idleRetry: _idleRetry,
    recoveryDueAt: _recoveryDueAt,
    turnStart: _turnStart,
    ...stateWithoutIdleRetry
  } = baseState;
  // Retries of an anchored record never move semantic `dueAt`; they write only
  // the retry time (RFC §5.4.2, "Timing clocks").
  const preserveSemanticDueAt = baseState.anchorFinalizedAt !== undefined;
  const nextState: PendingWorkState = {
    ...stateWithoutIdleRetry,
    dueAt: preserveSemanticDueAt ? baseState.dueAt : params.dueAt,
    ...(preserveSemanticDueAt ? { recoveryDueAt: params.dueAt } : {}),
    ...(params.retryCount !== undefined ? { retryCount: params.retryCount } : {}),
    ...(params.busySkipCount !== undefined ? { busySkipCount: params.busySkipCount } : {}),
    ...(params.idleRetry ? { idleRetry: params.idleRetry } : {}),
  };
  const updated = await writeWork(ownerOf(work, work.flowId), work.expectedRevision, {
    status: "queued",
    phase: "Requeued same-session continuation wake",
    failureReason: params.summary,
    ...statePatch(nextState),
  });
  if (updated.outcome !== "applied") {
    log.warn(
      `[continuation:work-requeue-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
  }
  return updated.outcome === "applied";
}

/**
 * Terminalize a continuation-work record as failed.
 *
 * Returns whether THIS caller committed the terminal transition: the revision
 * CAS is the durable once-only fact, so terminal side effects that must happen
 * exactly once key off the return value.
 *
 * `terminalNoticePending` records, in this same CAS write, that the agent still
 * owes a visible outcome, so the notice survives a crash. The store never
 * prunes a record while the obligation is set (RFC §5.4.6).
 */
export async function markPendingWorkFailed(
  work: PendingContinuationWork,
  summary: string,
  options: { terminalNoticePending?: "retry-exhausted" } = {},
): Promise<boolean> {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const result = await writeWork(ownerOf(work, work.flowId), work.expectedRevision, {
    status: "failed",
    phase: "Continuation work wake failed",
    failureReason: summary,
    ...(options.terminalNoticePending
      ? { terminalNoticePending: options.terminalNoticePending }
      : {}),
  });
  return result.outcome === "applied";
}

function toNoticeWork(record: ContinuationRecord): PendingContinuationWork | undefined {
  if (!isContinuationWorkFlow(record) || record.status !== "failed") {
    return undefined;
  }
  if (record.terminalNoticePending !== "retry-exhausted") {
    return undefined;
  }
  const state = decodeWorkState(record);
  return state
    ? {
        ...workToRuntime(record, state, "running"),
        terminalNoticePending:
          record.failureReason === WORK_TURN_INTERRUPTED_REASON
            ? "turn-interrupted"
            : "retry-exhausted",
      }
    : undefined;
}

/**
 * Every terminalized record still owing the agent a visible outcome. Terminal
 * records are invisible to {@link listPendingWorkSessionKeysForRecovery}, so
 * this is the dedicated recovery read for the notice obligation.
 */
export async function listPendingTerminalNoticeWork(): Promise<PendingContinuationWork[]> {
  return (await listContinuationRecords({ kinds: ["work"], statuses: ["failed"] })).flatMap(
    (record) => toNoticeWork(record) ?? [],
  );
}

/** Read one record's outstanding notice obligation with a current revision. */
export async function readPendingTerminalNoticeWork(
  flowId: string,
): Promise<PendingContinuationWork | undefined> {
  const record = await readWorkRecord(flowId);
  return record ? toNoticeWork(record) : undefined;
}

/**
 * Mark a matured continuation-work record superseded (drain-superseded): a
 * stale backlog member collapsed in favor of a newer election in the same
 * drain batch. The wake is NOT driven; the record finishes cleanly.
 */
export async function markPendingWorkSuperseded(
  work: PendingContinuationWork,
  summary: string,
): Promise<boolean> {
  return await finishContinuationWorkRecord(work, {
    phase: `superseded: ${summary}`.slice(0, 200),
    notCommittedTag: "work-supersede-not-committed",
  });
}

/**
 * Reap an orphan continuation-work record (bucket-1 cull): its parent run is
 * CONFIDENT-terminal and can never rehydrate it. Finished cleanly like a
 * supersede, because it is an intentional terminal, not an error.
 */
export async function markPendingWorkReaped(
  work: PendingContinuationWork,
  summary: string,
): Promise<boolean> {
  return await finishContinuationWorkRecord(work, {
    phase: `reaped: ${summary}`.slice(0, 200),
    notCommittedTag: "work-reap-not-committed",
  });
}

export async function peekSoonestUnmaturedWorkDueAt(
  sessionKey: string,
): Promise<number | undefined> {
  return await peekSoonestQueuedWorkDueAt(sessionKey, { after: Date.now() });
}

export async function peekSoonestQueuedWorkDueAt(
  sessionKey: string,
  options: { after?: number } = {},
): Promise<number | undefined> {
  let soonest: number | undefined;
  for (const record of await listOwnerWorkRecords(sessionKey, ["queued"])) {
    const state = decodeWorkState(record);
    if (!state) {
      continue;
    }
    const queuedDueAt = workRecordDueAt(state);
    if (options.after !== undefined && queuedDueAt <= options.after) {
      continue;
    }
    soonest = soonest === undefined ? queuedDueAt : Math.min(soonest, queuedDueAt);
  }
  return soonest;
}

export async function peekSoonestRunningWorkRecoveryDueAt(
  sessionKey: string,
  staleMs: number,
  now = Date.now(),
): Promise<number | undefined> {
  let soonest: number | undefined;
  for (const record of await listOwnerWorkRecords(sessionKey, ["running"])) {
    const state = decodeWorkState(record);
    // locus-3: a delivered-marked record stuck `running` (crash before the
    // finish) must not arm a recovery wake: consume skips it, so re-arming
    // would spin a no-op recovery loop.
    if (!state || state.succeeded) {
      continue;
    }
    const recoveryDueAt =
      state.idleRetry !== undefined
        ? record.updatedAt + staleMs
        : Math.max(workRecordDueAt(state), record.updatedAt + staleMs);
    if (recoveryDueAt <= now) {
      return now;
    }
    soonest = soonest === undefined ? recoveryDueAt : Math.min(soonest, recoveryDueAt);
  }
  return soonest;
}

export async function hasPendingIdleRetryWork(
  sessionKey: string,
  params: { trigger: PendingContinuationIdleRetry["trigger"]; excludeFlowId?: string },
): Promise<boolean> {
  return (await listOwnerWorkRecords(sessionKey, ["queued", "running"])).some((record) => {
    if (params.excludeFlowId !== undefined && record.recordId === params.excludeFlowId) {
      return false;
    }
    if (record.cancelRequestedAt !== undefined) {
      return false;
    }
    const state = decodeWorkState(record);
    return Boolean(state && !state.succeeded && state.idleRetry?.trigger === params.trigger);
  });
}

/**
 * Live work that is not durably delivered, or a live pending delegate. Staged post-compaction
 * delegates are excluded: cleanup fails them when it deletes the session.
 */
function isLiveCustodyRecord(record: ContinuationRecord): boolean {
  if (record.kind === "delegate") {
    return record.cancelRequestedAt === undefined;
  }
  // A durably delivered record left `running` by a crash is done, not live.
  return decodeWorkState(record)?.succeeded === undefined;
}

async function listLiveCustodyRecords(ownerSessionKey?: string): Promise<ContinuationRecord[]> {
  return await listContinuationRecords({
    ...(ownerSessionKey !== undefined ? { ownerSessionKey } : {}),
    kinds: ["work", "delegate"],
    statuses: ["queued", "running"],
  });
}

/**
 * Authoritative (async) cleanup guard: does the session still own live
 * continuation custody that needs it?
 */
export async function hasLiveContinuationCustody(sessionKey: string): Promise<boolean> {
  return (await listLiveCustodyRecords(sessionKey)).some(isLiveCustodyRecord);
}

/** Every session that owns live continuation custody, by the cleanup guard's rule. */
export async function listLiveContinuationCustodyOwners(): Promise<string[]> {
  const owners = new Set<string>();
  for (const record of await listLiveCustodyRecords()) {
    if (isLiveCustodyRecord(record)) {
      owners.add(record.ownerSessionKey);
    }
  }
  return [...owners];
}

/** Has this run already elected work for the session, in any status, including work that ran? */
export async function hasContinuationWorkFromRun(
  sessionKey: string,
  originRunId: string,
): Promise<boolean> {
  return (await listOwnerWorkRecords(sessionKey)).some(
    (record) => decodeWorkState(record)?.originRunId === originRunId,
  );
}

function readOwnerLiveWorkFacts(sessionKey: string) {
  const answer = readContinuationLiveWork(resolveContinuationCustodyDatabasePath(), sessionKey, [
    "work",
  ]);
  return answer.state === "known" ? answer.records : undefined;
}

/** Live work records for a session, from the hot-path projection (§5.4.6). */
export function pendingWorkCount(sessionKey: string): number {
  return readOwnerLiveWorkFacts(sessionKey)?.length ?? 0;
}

/**
 * Synchronous cleanup guard: does the session hold live continuation work?
 * Read from the hot-path projection. An owner the projection cannot answer
 * for counts as live, so subagent cleanup errs toward retention. A durably
 * delivered record left `running` by a crash reads as live here until startup
 * recovery finalizes it.
 */
export function hasLiveOrRecentlyDispatchedContinuationWork(sessionKey: string): boolean {
  const facts = readOwnerLiveWorkFacts(sessionKey);
  return facts === undefined ? true : facts.length > 0;
}
