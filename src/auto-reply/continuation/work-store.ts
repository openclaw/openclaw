/**
 * Durable continue_work store — TaskFlow-backed same-session continuation.
 *
 * `continue_work` elects another turn in the same session. The volatile timer is
 * only a maturity wake; the election itself lives in TaskFlow so gateway restart
 * can re-arm it and subagent cleanup can retain the session until the wake is
 * delivered.
 */

import { z } from "zod";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  failFlow,
  finishFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  listTaskFlowsForOwnerKey,
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-runtime-internal.js";

const log = createSubsystemLogger("continuation/work-store");

export const CONTINUATION_WORK_CONTROLLER_ID = "core/continuation-work";

const PendingWorkStateSchema = z.object({
  kind: z.literal("continuation_work"),
  sessionKey: z.string().min(1),
  hop: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
  electedAt: z.number().int().nonnegative(),
  dueAt: z.number().int().nonnegative(),
  maxChainLength: z.number().int().positive(),
  chainStartedAt: z.number().int().nonnegative().optional(),
  accumulatedChainTokens: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
  parentRunId: z.string().optional(),
  chainId: z.string().optional(),
  traceparent: z.string().optional(),
  releasedAt: z.number().int().nonnegative().optional(),
  turnGrantedAt: z.number().int().nonnegative().optional(),
  retryCount: z.number().int().nonnegative().optional(),
  // Consecutive PRE-drive busy-skip (requests-in-flight/draining/queue-busy)
  // count for diagnostics and rate state. DISTINCT from retryCount — a busy-skip
  // is a legit defer, never a failed attempt, so it must not feed the fail-bound.
  busySkipCount: z.number().int().nonnegative().optional(),
  // Event-driven busy retry: when a wake is blocked by an active turn or the
  // main lane, the row parks behind the matching idle event and keeps a slow
  // hedge timer only as loss recovery.
  idleRetry: z
    .object({
      trigger: z.enum(["reply-run-ended", "command-lane-idle"]),
      reasonCategory: z.enum(["follow-up-work", "wait-shaped", "unknown"]),
      armedAt: z.number().int().nonnegative(),
    })
    .optional(),
  // #990 locus-3: durable delivered-mark written AFTER a wake is confirmed
  // delivered but BEFORE the persist-gap that precedes finishFlow. The
  // consume read-guard skips any flow carrying it so a crash in that window
  // never re-delivers (restart-gap dup cure). Two-axis legible: PRESENT=terminal.
  succeeded: z.object({ point: z.literal("optimal"), durability: z.literal("durable") }).optional(),
});

type PendingWorkState = z.infer<typeof PendingWorkStateSchema>;

export type ContinuationWorkReasonCategory = "follow-up-work" | "wait-shaped" | "unknown";

export type PendingContinuationIdleRetry = {
  trigger: "reply-run-ended" | "command-lane-idle";
  reasonCategory: ContinuationWorkReasonCategory;
  armedAt: number;
};

export type PendingContinuationWork = {
  sessionKey: string;
  hop: number;
  delayMs: number;
  electedAt: number;
  dueAt: number;
  maxChainLength: number;
  chainStartedAt?: number;
  accumulatedChainTokens?: number;
  reason?: string;
  parentRunId?: string;
  chainId?: string;
  traceparent?: string;
  retryCount?: number;
  // Consecutive busy-skip count for diagnostics/rate state. Distinct from
  // retryCount (the transient-error fail-bound). Never penalizes.
  busySkipCount?: number;
  idleRetry?: PendingContinuationIdleRetry;
  // #990 locus-3: durable delivered-mark (see schema). PRESENT once a wake was
  // confirmed delivered; the consume read-guard refuses to re-drive it.
  succeeded?: { point: "optimal"; durability: "durable" };
  flowId?: string;
  expectedRevision?: number;
  // Durable flow status carried onto the runtime object by the store reader
  // ({@link workToRuntime}), sourced from the flow's PRE-claim status. The
  // fold-side write-guard (#988-P2-1) needs this to tell a recovered `running`
  // turn (actively executing) from genuine `queued` backlog so a live turn is
  // never finished-as-superseded. Absent on freshly-constructed enqueue inputs;
  // only store reads populate it.
  status?: "queued" | "running";
};

function isContinuationWorkFlow(flow: TaskFlowRecord): boolean {
  return flow.syncMode === "managed" && flow.controllerId === CONTINUATION_WORK_CONTROLLER_ID;
}

function isRecoverableWorkFlow(flow: TaskFlowRecord): boolean {
  return isContinuationWorkFlow(flow) && (flow.status === "queued" || flow.status === "running");
}

function decodeWorkState(flow: TaskFlowRecord): PendingWorkState | undefined {
  const parsed = PendingWorkStateSchema.safeParse(flow.stateJson);
  return parsed.success ? parsed.data : undefined;
}

function finalizeDeliveredWorkFlow(flow: TaskFlowRecord, state: PendingWorkState): void {
  const now = Date.now();
  const finished = finishFlow({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    currentStep: "Same-session continuation turn granted",
    stateJson: {
      ...state,
      turnGrantedAt: state.turnGrantedAt ?? now,
      busySkipCount: 0,
    },
    updatedAt: now,
    endedAt: now,
  });
  if (!finished.applied) {
    log.warn(
      `[continuation:work-delivered-finish-not-committed] flowId=${flow.flowId} expectedRevision=${flow.revision}`,
    );
  }
}

function workGoal(work: PendingContinuationWork): string {
  const reason = work.reason?.trim();
  return reason ? `Continuation work: ${reason.slice(0, 80)}` : "Continuation work";
}

function workToRuntime(
  flow: TaskFlowRecord,
  state: PendingWorkState,
  status: "queued" | "running",
): PendingContinuationWork {
  return {
    sessionKey: state.sessionKey,
    hop: state.hop,
    delayMs: state.delayMs,
    electedAt: state.electedAt,
    dueAt: state.dueAt,
    maxChainLength: state.maxChainLength,
    ...(state.chainStartedAt !== undefined ? { chainStartedAt: state.chainStartedAt } : {}),
    ...(state.accumulatedChainTokens !== undefined
      ? { accumulatedChainTokens: state.accumulatedChainTokens }
      : {}),
    ...(state.reason ? { reason: state.reason } : {}),
    ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
    ...(state.chainId ? { chainId: state.chainId } : {}),
    ...(state.traceparent ? { traceparent: state.traceparent } : {}),
    ...(state.retryCount !== undefined ? { retryCount: state.retryCount } : {}),
    ...(state.busySkipCount !== undefined ? { busySkipCount: state.busySkipCount } : {}),
    ...(state.idleRetry ? { idleRetry: state.idleRetry } : {}),
    ...(state.succeeded ? { succeeded: state.succeeded } : {}),
    status,
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  };
}

export function enqueuePendingWork(work: PendingContinuationWork): PendingContinuationWork | null {
  const state: PendingWorkState = {
    kind: "continuation_work",
    sessionKey: work.sessionKey,
    hop: work.hop,
    delayMs: work.delayMs,
    electedAt: work.electedAt,
    dueAt: work.dueAt,
    maxChainLength: work.maxChainLength,
    ...(work.chainStartedAt !== undefined ? { chainStartedAt: work.chainStartedAt } : {}),
    ...(work.accumulatedChainTokens !== undefined
      ? { accumulatedChainTokens: work.accumulatedChainTokens }
      : {}),
    ...(work.reason ? { reason: work.reason } : {}),
    ...(work.parentRunId ? { parentRunId: work.parentRunId } : {}),
    ...(work.chainId ? { chainId: work.chainId } : {}),
    ...(work.traceparent ? { traceparent: work.traceparent } : {}),
  };
  const flow = createManagedTaskFlow({
    ownerKey: work.sessionKey,
    controllerId: CONTINUATION_WORK_CONTROLLER_ID,
    notifyPolicy: "silent",
    goal: workGoal(work),
    currentStep: "Queued for same-session continuation wake",
    stateJson: state,
    createdAt: work.electedAt,
  });
  return flow ? workToRuntime(flow, state, "queued") : null;
}

export function listPendingWorkSessionKeysForRecovery(): string[] {
  const keys = listTaskFlowRecords()
    .filter(isRecoverableWorkFlow)
    .map((flow) => flow.ownerKey);
  return [...new Set(keys)].toSorted();
}

export function consumePendingWork(
  sessionKey: string,
  options: {
    includeRunning?: boolean;
    includeRunningUpdatedAtOrBefore?: number;
    includeIdleRetry?: boolean;
  } = {},
): PendingContinuationWork[] {
  const now = Date.now();
  const work: PendingContinuationWork[] = [];
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)
    .filter(isContinuationWorkFlow)
    .toSorted((a, b) => a.createdAt - b.createdAt)) {
    // #990 Pillar-0 (:259 dedup harden): a cancel-requested flow is terminating
    // — never consume/drive it. cancelFlowById finalizes managed continuation
    // work to `cancelled` synchronously, but a transient revision conflict can
    // leave it cancelRequestedAt-marked yet not-yet-terminal until the
    // maintenance reaper (task-flow-registry.maintenance.ts) finalizes it.
    // Honoring the request here means a cancelled wake is never granted a turn
    // out from under the cancel. Terminal statuses are already excluded below.
    if (flow.cancelRequestedAt != null) {
      continue;
    }
    if (flow.status !== "queued" && flow.status !== "running") {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state) {
      log.warn(
        `[continuation:work-decode-failed] flowId=${flow.flowId} session=${sessionKey} raw=${JSON.stringify(flow.stateJson).slice(0, 200)}`,
      );
      failFlow({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: "Rejected invalid continuation work payload",
        blockedSummary: "Pending continuation work payload could not be decoded.",
      });
      continue;
    }
    // #990 locus-3 read-guard: a durably delivered-marked flow was confirmed
    // delivered before the persist-gap. Even if its status is still `running`
    // (the process died after the durable mark but before finishFlow finalized
    // it), never re-consume it — that would be a restart-gap double-delivery.
    if (state.succeeded) {
      finalizeDeliveredWorkFlow(flow, state);
      continue;
    }
    const canConsumeRunning =
      flow.status === "running" &&
      options.includeRunning === true &&
      (options.includeRunningUpdatedAtOrBefore === undefined ||
        flow.updatedAt <= options.includeRunningUpdatedAtOrBefore);
    if (flow.status !== "queued" && !canConsumeRunning) {
      continue;
    }
    const idleRetryReady = options.includeIdleRetry === true && state.idleRetry !== undefined;
    if (now < state.dueAt && !idleRetryReady) {
      continue;
    }
    const releasedAt = Date.now();
    const claimed = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "running",
        currentStep:
          flow.status === "running"
            ? "Re-driving same-session continuation wake"
            : "Released to continuation wake scheduler",
        stateJson: { ...state, releasedAt },
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
        endedAt: null,
        updatedAt: releasedAt,
      },
    });
    if (!claimed.applied || !claimed.flow) {
      continue;
    }
    // Carry the PRE-claim durable status: the claim above flips every consumed
    // flow to `running`, so claimed.flow.status can no longer distinguish a
    // recovered active turn from freshly-released queued backlog. The fold-side
    // write-guard (#988-P2-1) keys off this original status.
    const originalStatus: "queued" | "running" = flow.status === "running" ? "running" : "queued";
    work.push(workToRuntime(claimed.flow, { ...state, releasedAt }, originalStatus));
  }
  return work;
}

function buildFallbackWorkState(work: PendingContinuationWork): PendingWorkState {
  return {
    kind: "continuation_work",
    sessionKey: work.sessionKey,
    hop: work.hop,
    delayMs: work.delayMs,
    electedAt: work.electedAt,
    dueAt: work.dueAt,
    maxChainLength: work.maxChainLength,
  };
}

/**
 * Finish a continuation-work flow cleanly (terminal, no failure/retry).
 *
 * Shared by the turn-granted, superseded (#986), and orphan-reaped (#990) paths:
 * each is an INTENTIONAL terminal — the wake will not re-arm — distinct from
 * {@link markPendingWorkFailed} (error path). `stateExtra` carries the
 * path-specific durable state; `turnGrantedAt` is always stamped so the flow
 * reads as delivered/closed by downstream consumers.
 */
function finishContinuationWorkFlow(
  work: PendingContinuationWork,
  params: { currentStep: string; stateExtra?: Record<string, unknown>; notCommittedTag: string },
): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const now = Date.now();
  const baseState: PendingWorkState = state ?? buildFallbackWorkState(work);
  const { idleRetry: _idleRetry, ...terminalState } = baseState;
  const finished = finishFlow({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    currentStep: params.currentStep,
    stateJson: {
      ...terminalState,
      turnGrantedAt: now,
      ...params.stateExtra,
    },
    updatedAt: now,
    endedAt: now,
  });
  if (!finished.applied) {
    log.warn(
      `[continuation:${params.notCommittedTag}] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
  }
  return finished.applied;
}

export function markPendingWorkTurnGranted(work: PendingContinuationWork): boolean {
  return finishContinuationWorkFlow(work, {
    currentStep: "Same-session continuation turn granted",
    // A flow that drove is no longer busy-deferred — clear the busy counter so
    // the granted record never carries stale retry state.
    stateExtra: { busySkipCount: 0 },
    notCommittedTag: "work-finish-not-committed",
  });
}

/**
 * Durably mark a continuation wake delivered, BEFORE the persist-gap (#990 locus-3).
 *
 * Written the instant a wake is confirmed delivered (the agent turn ran),
 * before the dispatch loop's follow-on {@link markPendingWorkTurnGranted}
 * finalizes the flow. The flow stays `running`; only `stateJson.succeeded` is
 * set, so a crash in the deliver→finalize window leaves a row the consume
 * read-guard recognizes as delivered (no restart-gap re-delivery). The bumped
 * revision and durable marker are threaded back onto `work` so the follow-on
 * finishFlow still applies. INVARIANT (load-bearing): the mark is durably
 * persisted here — an in-memory-only mark is lost with the process and the gap
 * stays open.
 */
export function markPendingWorkDelivered(work: PendingContinuationWork): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const now = Date.now();
  const succeeded = { point: "optimal", durability: "durable" } as const;
  const updated = updateFlowRecordByIdExpectedRevision({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    patch: {
      currentStep: "Continuation wake delivered (durable mark)",
      stateJson: { ...(state ?? buildFallbackWorkState(work)), succeeded },
      updatedAt: now,
    },
  });
  if (!updated.applied || !updated.flow) {
    log.warn(
      `[continuation:work-deliver-mark-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
    return false;
  }
  work.expectedRevision = updated.flow.revision;
  work.succeeded = succeeded;
  return true;
}

export function requeuePendingWork(
  work: PendingContinuationWork,
  params: {
    dueAt: number;
    summary: string;
    retryCount?: number;
    busySkipCount?: number;
    idleRetry?: PendingContinuationIdleRetry;
  },
): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const baseState: PendingWorkState = state ?? {
    kind: "continuation_work",
    sessionKey: work.sessionKey,
    hop: work.hop,
    delayMs: work.delayMs,
    electedAt: work.electedAt,
    dueAt: work.dueAt,
    maxChainLength: work.maxChainLength,
  };
  const { idleRetry: _idleRetry, ...stateWithoutIdleRetry } = baseState;
  const nextState: PendingWorkState = {
    ...stateWithoutIdleRetry,
    dueAt: params.dueAt,
    ...(params.retryCount !== undefined ? { retryCount: params.retryCount } : {}),
    ...(params.busySkipCount !== undefined ? { busySkipCount: params.busySkipCount } : {}),
    ...(params.idleRetry ? { idleRetry: params.idleRetry } : {}),
  };
  const updated = updateFlowRecordByIdExpectedRevision({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    patch: {
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
      stateJson: nextState,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: params.summary,
      endedAt: null,
      updatedAt: Date.now(),
    },
  });
  if (!updated.applied) {
    log.warn(
      `[continuation:work-requeue-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
  }
  return updated.applied;
}

export function markPendingWorkFailed(work: PendingContinuationWork, summary: string): void {
  if (!work.flowId || work.expectedRevision === undefined) {
    return;
  }
  failFlow({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    currentStep: "Continuation work wake failed",
    blockedSummary: summary,
    updatedAt: Date.now(),
  });
}

/**
 * Mark a matured continuation-work flow superseded (#986 drain-superseded).
 *
 * Used when a stale backlog member is collapsed in favour of a newer election in
 * the same drain batch — the wake is NOT driven; the flow is finished cleanly so
 * it stops re-arming. Distinct from failure (no system-warning, no retry): a
 * superseded wake was intentionally folded, not dropped by error.
 */
export function markPendingWorkSuperseded(work: PendingContinuationWork, summary: string): boolean {
  return finishContinuationWorkFlow(work, {
    currentStep: `superseded: ${summary}`.slice(0, 200),
    notCommittedTag: "work-supersede-not-committed",
  });
}

/**
 * Reap an orphan continuation-work flow (#990 bucket-1 cull).
 *
 * Used when the flow's parent run is CONFIDENT-terminal and can never rehydrate
 * it (read-time liveness join). Finished cleanly like a supersede — no
 * system-warning, no retry — because it is an intentional terminal, not an
 * error. The delegate-flow-gate + confident-terminal requirement upstream
 * guarantee a same-session/uncertain flow is never reaped here.
 */
export function markPendingWorkReaped(work: PendingContinuationWork, summary: string): boolean {
  return finishContinuationWorkFlow(work, {
    currentStep: `reaped: ${summary}`.slice(0, 200),
    notCommittedTag: "work-reap-not-committed",
  });
}

export function peekSoonestUnmaturedWorkDueAt(sessionKey: string): number | undefined {
  const now = Date.now();
  return peekSoonestQueuedWorkDueAt(sessionKey, { after: now });
}

export function peekSoonestQueuedWorkDueAt(
  sessionKey: string,
  options: { after?: number } = {},
): number | undefined {
  let soonest: number | undefined;
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)) {
    if (!isContinuationWorkFlow(flow) || flow.status !== "queued") {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state) {
      continue;
    }
    if (options.after !== undefined && state.dueAt <= options.after) {
      continue;
    }
    soonest = soonest === undefined ? state.dueAt : Math.min(soonest, state.dueAt);
  }
  return soonest;
}

export function peekSoonestRunningWorkRecoveryDueAt(
  sessionKey: string,
  staleMs: number,
  now = Date.now(),
): number | undefined {
  let soonest: number | undefined;
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)) {
    if (!isContinuationWorkFlow(flow) || flow.status !== "running") {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state) {
      continue;
    }
    // #990 locus-3: a delivered-marked flow stuck `running` (crash before
    // finishFlow) must not arm a recovery wake — consume would skip it via the
    // read-guard, so re-arming here would spin a tight no-op recovery loop.
    if (state.succeeded) {
      continue;
    }
    const recoveryDueAt =
      state.idleRetry !== undefined
        ? flow.updatedAt + staleMs
        : Math.max(state.dueAt, flow.updatedAt + staleMs);
    if (recoveryDueAt <= now) {
      return now;
    }
    soonest = soonest === undefined ? recoveryDueAt : Math.min(soonest, recoveryDueAt);
  }
  return soonest;
}

export function hasPendingIdleRetryWork(
  sessionKey: string,
  params: { trigger: PendingContinuationIdleRetry["trigger"]; excludeFlowId?: string },
): boolean {
  return listTaskFlowsForOwnerKey(sessionKey).some((flow) => {
    if (!isContinuationWorkFlow(flow) || (flow.status !== "queued" && flow.status !== "running")) {
      return false;
    }
    if (params.excludeFlowId !== undefined && flow.flowId === params.excludeFlowId) {
      return false;
    }
    if (flow.cancelRequestedAt != null) {
      return false;
    }
    const state = decodeWorkState(flow);
    if (!state || state.succeeded) {
      return false;
    }
    return state.idleRetry?.trigger === params.trigger;
  });
}

export function pendingWorkCount(sessionKey: string): number {
  return listTaskFlowsForOwnerKey(sessionKey).filter(isRecoverableWorkFlow).length;
}

/**
 * Count only QUEUED (future, undelivered) continuation-work flows.
 *
 * The #986 maxPendingWork cap uses this rather than {@link pendingWorkCount}
 * (which also counts `running`). At enqueue time the currently-driving wake is
 * still `running` (it is only marked succeeded after `getReplyFromConfig`
 * returns), so counting `running` would make the active wake reject its own
 * serial successor — at `maxPendingWork:1` a normal one-at-a-time chain would
 * self-cap to zero. Counting only `queued` means the cap bounds *future pending*
 * wakes (the flood surface) without penalizing the in-flight driver.
 */
export function queuedPendingWorkCount(sessionKey: string): number {
  return listTaskFlowsForOwnerKey(sessionKey).filter(
    (flow) => isContinuationWorkFlow(flow) && flow.status === "queued",
  ).length;
}

export function hasLiveOrRecentlyDispatchedContinuationWork(sessionKey: string): boolean {
  return listTaskFlowsForOwnerKey(sessionKey).some((flow) => {
    if (!isContinuationWorkFlow(flow)) {
      return false;
    }
    if (flow.status !== "queued" && flow.status !== "running") {
      return false;
    }
    // #990 P2 (#996): a durably delivered-marked flow is DONE, not live. The
    // locus-3 mark deliberately leaves it `status:running` until finishFlow
    // finalizes it; if the process crashed in the mark->finishFlow gap, the row
    // stays `running` but is already delivered. The consume-guards (:221, :485)
    // already exclude `state.succeeded` rows from re-delivery; the cleanup
    // live-check must match, or `deleteSubagentSessionForCleanup` /
    // the registry sweep treat the delivered row as live and strand its child
    // session forever. Exclude delivered-marked rows here too.
    if (decodeWorkState(flow)?.succeeded) {
      return false;
    }
    return true;
  });
}
