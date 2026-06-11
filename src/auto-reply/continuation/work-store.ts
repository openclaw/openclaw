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
  // #990 Pillar-0: consecutive PRE-drive busy-skip (requests-in-flight/draining)
  // count for exp-backoff on the re-arm. DISTINCT from retryCount — a busy-skip is
  // a legit defer, never a failed attempt, so it must not feed the fail-bound.
  busySkipCount: z.number().int().nonnegative().optional(),
});

type PendingWorkState = z.infer<typeof PendingWorkStateSchema>;

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
  // #990 Pillar-0: consecutive busy-skip count for exp-backoff on the busy re-arm.
  // Distinct from retryCount (the transient-error fail-bound). Never penalizes.
  busySkipCount?: number;
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
  options: { includeRunning?: boolean; includeRunningUpdatedAtOrBefore?: number } = {},
): PendingContinuationWork[] {
  const now = Date.now();
  const work: PendingContinuationWork[] = [];
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)
    .filter((candidate) => {
      if (!isContinuationWorkFlow(candidate)) {
        return false;
      }
      // #990 Pillar-0 (:259 dedup harden): a cancel-requested flow is terminating
      // — never consume/drive it. cancelFlowById finalizes managed continuation
      // work to `cancelled` synchronously, but a transient revision conflict can
      // leave it cancelRequestedAt-marked yet not-yet-terminal until the
      // maintenance reaper (task-flow-registry.maintenance.ts) finalizes it.
      // Honoring the request here means a cancelled wake is never granted a turn
      // out from under the cancel. Terminal statuses are already excluded below.
      if (candidate.cancelRequestedAt != null) {
        return false;
      }
      if (options.includeRunning) {
        return (
          candidate.status === "queued" ||
          (candidate.status === "running" &&
            (options.includeRunningUpdatedAtOrBefore === undefined ||
              candidate.updatedAt <= options.includeRunningUpdatedAtOrBefore))
        );
      }
      return candidate.status === "queued";
    })
    .toSorted((a, b) => a.createdAt - b.createdAt)) {
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
    if (now < state.dueAt) {
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

export function markPendingWorkTurnGranted(work: PendingContinuationWork): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const now = Date.now();
  const finished = finishFlow({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    currentStep: "Same-session continuation turn granted",
    stateJson: {
      ...(state ?? {
        kind: "continuation_work",
        sessionKey: work.sessionKey,
        hop: work.hop,
        delayMs: work.delayMs,
        electedAt: work.electedAt,
        dueAt: work.dueAt,
        maxChainLength: work.maxChainLength,
      }),
      turnGrantedAt: now,
      // #990 Pillar-0: a flow that drove is no longer busy-deferred — clear the
      // exp-backoff counter so the granted record never carries a stale rate-cap.
      busySkipCount: 0,
    },
    updatedAt: now,
    endedAt: now,
  });
  if (!finished.applied) {
    log.warn(
      `[continuation:work-finish-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
  }
  return finished.applied;
}

export function requeuePendingWork(
  work: PendingContinuationWork,
  params: { dueAt: number; summary: string; retryCount?: number; busySkipCount?: number },
): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const nextState: PendingWorkState = {
    ...(state ?? {
      kind: "continuation_work",
      sessionKey: work.sessionKey,
      hop: work.hop,
      delayMs: work.delayMs,
      electedAt: work.electedAt,
      dueAt: work.dueAt,
      maxChainLength: work.maxChainLength,
    }),
    dueAt: params.dueAt,
    ...(params.retryCount !== undefined ? { retryCount: params.retryCount } : {}),
    ...(params.busySkipCount !== undefined ? { busySkipCount: params.busySkipCount } : {}),
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
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const now = Date.now();
  const finished = finishFlow({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    currentStep: `superseded: ${summary}`.slice(0, 200),
    stateJson: {
      ...(state ?? {
        kind: "continuation_work",
        sessionKey: work.sessionKey,
        hop: work.hop,
        delayMs: work.delayMs,
        electedAt: work.electedAt,
        dueAt: work.dueAt,
        maxChainLength: work.maxChainLength,
      }),
      turnGrantedAt: now,
    },
    updatedAt: now,
    endedAt: now,
  });
  if (!finished.applied) {
    log.warn(
      `[continuation:work-supersede-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
  }
  return finished.applied;
}

export function peekSoonestUnmaturedWorkDueAt(sessionKey: string): number | undefined {
  const now = Date.now();
  let soonest: number | undefined;
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)) {
    if (!isContinuationWorkFlow(flow) || flow.status !== "queued") {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state) {
      continue;
    }
    if (state.dueAt <= now) {
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
    const recoveryDueAt = Math.max(state.dueAt, flow.updatedAt + staleMs);
    if (recoveryDueAt <= now) {
      return now;
    }
    soonest = soonest === undefined ? recoveryDueAt : Math.min(soonest, recoveryDueAt);
  }
  return soonest;
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
  return listTaskFlowsForOwnerKey(sessionKey).some(
    (flow) =>
      isContinuationWorkFlow(flow) && (flow.status === "queued" || flow.status === "running"),
  );
}
