/**
 * Continuation delegate store — pure TaskFlow-backed.
 *
 * Every delegate operation goes through TaskFlow (SQLite persistence).
 * Zero volatile Maps. Delegates survive gateway restarts by design.
 *
 * Adds Zod validation on state payloads, a `releasedAt` audit trail, and
 * `failFlow` for corrupt records on top of the base TaskFlow store.
 *
 * RFC: docs/design/continue-work-signal-v2.md §5.4
 */

import { z } from "zod";
import type {
  DiagnosticContinuationQueueHistoryPoint,
  DiagnosticContinuationQueueMetrics,
  DiagnosticContinuationQueueOwnerSample,
} from "../../infra/diagnostic-events.js";
import {
  DIAGNOSTIC_TRACEPARENT_PATTERN,
  normalizeDiagnosticTraceparent,
} from "../../infra/diagnostic-trace-context.js";
import { registerDiagnosticContinuationQueueMetricsProvider } from "../../logging/diagnostic-continuation-queues.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  deleteTaskFlowRecordById,
  failFlow,
  finishFlow,
  listTaskFlowRecords,
  listTaskFlowsForOwnerKey,
} from "../../tasks/task-flow-runtime-internal.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting.js";
import type {
  DelayedContinuationReservation,
  PendingContinuationDelegate,
  StagedPostCompactionDelegate,
} from "./types.js";

const log = createSubsystemLogger("continuation/delegate-store");

// ---------------------------------------------------------------------------
// Controller IDs (exported for test assertions)
// ---------------------------------------------------------------------------

export const CONTINUATION_DELEGATE_CONTROLLER_ID = "core/continuation-delegate";
export const CONTINUATION_POST_COMPACTION_CONTROLLER_ID = "core/continuation-post-compaction";

// ---------------------------------------------------------------------------
// Zod validation for TaskFlow state payloads
// ---------------------------------------------------------------------------

const TraceparentStateSchema = z
  .preprocess(
    (value) => (value === null ? undefined : value),
    z
      .string()
      .regex(new RegExp(DIAGNOSTIC_TRACEPARENT_PATTERN))
      .refine((value) => normalizeDiagnosticTraceparent(value) !== undefined, {
        message: "invalid W3C traceparent",
      })
      .transform((value) => normalizeDiagnosticTraceparent(value)!)
      .optional(),
  )
  .optional();

const PendingDelegateStateSchema = z
  .object({
    kind: z.literal("continuation_delegate"),
    task: z.string().min(1),
    delayMs: z.number().int().nonnegative().optional(),
    silent: z.boolean().optional(),
    silentWake: z.boolean().optional(),
    postCompaction: z.boolean().optional(),
    firstArmedAt: z.number().int().nonnegative().optional(),
    targetSessionKey: z.string().min(1).optional(),
    targetSessionKeys: z.array(z.string().min(1)).optional(),
    fanoutMode: z.enum(CONTINUATION_DELEGATE_FANOUT_MODES).optional(),
    traceparent: TraceparentStateSchema,
  })
  .superRefine((state, ctx) => {
    const hasSilent = state.silent === true;
    const hasSilentWake = state.silentWake === true;
    const hasPostCompaction = state.postCompaction === true;
    const flagCount = [hasSilent, hasSilentWake, hasPostCompaction].filter(Boolean).length;
    if (
      state.fanoutMode &&
      (state.targetSessionKey || (state.targetSessionKeys && state.targetSessionKeys.length > 0))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "continuation delegate payload cannot combine explicit targets with fanoutMode",
      });
      return;
    }
    if (flagCount <= 1 || (hasSilent && hasSilentWake && !hasPostCompaction)) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "continuation delegate payload has incompatible mode flags",
    });
  });

type PendingDelegateState = z.infer<typeof PendingDelegateStateSchema>;

export type ContinuationDelegateQueueDepths = {
  pendingQueued: number;
  pendingRunnable: number;
  pendingScheduled: number;
  stagedPostCompaction: number;
  totalQueued: number;
};

const CONTINUATION_QUEUE_HISTORY_LIMIT = 8;
let continuationQueueDiagnosticsLastSampleAt: number | undefined;
const continuationQueueDiagnosticsHistory: DiagnosticContinuationQueueHistoryPoint[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDelegateGoal(delegate: PendingContinuationDelegate): string {
  const task = delegate.task.trim();
  const isPostCompaction = delegate.mode === "post-compaction";
  if (!task) {
    return isPostCompaction ? "Post-compaction continuation delegate" : "Continuation delegate";
  }
  const excerpt = task.length > 80 ? `${task.slice(0, 77)}...` : task;
  return isPostCompaction
    ? `Post-compaction delegate: ${excerpt}`
    : `Continuation delegate: ${excerpt}`;
}

function buildDelegateState(delegate: PendingContinuationDelegate): PendingDelegateState {
  // `mode` is the sole runtime-surface encoding. Project it into the on-disk
  // boolean flags so existing persisted records
  // (which predate the mode-only runtime shape) keep their familiar schema
  // and `decodeDelegateState` / `flowToDelegate` keep working unchanged for
  // historical TaskFlow rows.
  const targetSessionKey = normalizeContinuationTargetKey(delegate.targetSessionKey);
  const targetSessionKeys = normalizeContinuationTargetKeys(delegate.targetSessionKeys);
  const traceparent = normalizeDiagnosticTraceparent(delegate.traceparent);
  return {
    kind: "continuation_delegate",
    task: delegate.task,
    ...(delegate.delayMs !== undefined ? { delayMs: delegate.delayMs } : {}),
    ...(delegate.mode === "silent" ? { silent: true } : {}),
    ...(delegate.mode === "silent-wake" ? { silentWake: true } : {}),
    ...(delegate.mode === "post-compaction" ? { postCompaction: true } : {}),
    ...(delegate.firstArmedAt !== undefined ? { firstArmedAt: delegate.firstArmedAt } : {}),
    ...(targetSessionKey ? { targetSessionKey } : {}),
    ...(targetSessionKeys.length > 0 ? { targetSessionKeys } : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(traceparent ? { traceparent } : {}),
  };
}

function isPendingDelegateFlow(flow: TaskFlowRecord): boolean {
  return flow.syncMode === "managed" && flow.controllerId === CONTINUATION_DELEGATE_CONTROLLER_ID;
}

function isPostCompactionDelegateFlow(flow: TaskFlowRecord): boolean {
  return (
    flow.syncMode === "managed" && flow.controllerId === CONTINUATION_POST_COMPACTION_CONTROLLER_ID
  );
}

function isContinuationDelegateFlow(flow: TaskFlowRecord): boolean {
  return isPendingDelegateFlow(flow) || isPostCompactionDelegateFlow(flow);
}

function listQueuedPendingFlows(sessionKey: string): TaskFlowRecord[] {
  return listTaskFlowsForOwnerKey(sessionKey)
    .filter((flow) => isPendingDelegateFlow(flow) && flow.status === "queued")
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

function listQueuedPostCompactionFlows(sessionKey: string): TaskFlowRecord[] {
  return listTaskFlowsForOwnerKey(sessionKey)
    .filter((flow) => isPostCompactionDelegateFlow(flow) && flow.status === "queued")
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

function decodeDelegateState(flow: TaskFlowRecord): PendingDelegateState | undefined {
  const parsed = PendingDelegateStateSchema.safeParse(flow.stateJson);
  return parsed.success ? parsed.data : undefined;
}

function countFlowsChangedSince(
  flows: TaskFlowRecord[],
  status: TaskFlowRecord["status"],
  since: number | undefined,
  now: number,
): number {
  if (since === undefined) {
    return 0;
  }
  return flows.filter((flow) => {
    const changedAt = flow.endedAt ?? flow.updatedAt;
    return flow.status === status && changedAt > since && changedAt <= now;
  }).length;
}

function createEmptyOwnerQueueSample(sessionKey: string): DiagnosticContinuationQueueOwnerSample {
  return {
    sessionKey,
    pendingQueued: 0,
    pendingRunnable: 0,
    pendingScheduled: 0,
    stagedPostCompaction: 0,
    invalidQueued: 0,
    totalQueued: 0,
  };
}

function noteOwnerQueuedFlow(
  owner: DiagnosticContinuationQueueOwnerSample,
  flow: TaskFlowRecord,
  now: number,
): void {
  owner.totalQueued += 1;
  const queuedAgeMs = Math.max(0, now - flow.createdAt);
  owner.oldestQueuedAgeMs = Math.max(owner.oldestQueuedAgeMs ?? 0, queuedAgeMs);
  owner.newestQueuedAgeMs =
    owner.newestQueuedAgeMs === undefined
      ? queuedAgeMs
      : Math.min(owner.newestQueuedAgeMs, queuedAgeMs);
}

function buildContinuationQueueDiagnostics(
  now = Date.now(),
): DiagnosticContinuationQueueMetrics | undefined {
  const flows = listTaskFlowRecords().filter(isContinuationDelegateFlow);
  const intervalMs =
    continuationQueueDiagnosticsLastSampleAt !== undefined
      ? Math.max(0, now - continuationQueueDiagnosticsLastSampleAt)
      : undefined;
  const previousSampleAt = continuationQueueDiagnosticsLastSampleAt;
  const enqueuedSinceLastSample =
    previousSampleAt === undefined
      ? 0
      : flows.filter((flow) => flow.createdAt > previousSampleAt && flow.createdAt <= now).length;
  const drainedSinceLastSample = countFlowsChangedSince(flows, "succeeded", previousSampleAt, now);
  const failedSinceLastSample = countFlowsChangedSince(flows, "failed", previousSampleAt, now);

  const owners = new Map<string, DiagnosticContinuationQueueOwnerSample>();
  let pendingQueued = 0;
  let pendingRunnable = 0;
  let pendingScheduled = 0;
  let stagedPostCompaction = 0;
  let invalidQueued = 0;

  for (const flow of flows) {
    if (flow.status !== "queued") {
      continue;
    }
    const owner = owners.get(flow.ownerKey) ?? createEmptyOwnerQueueSample(flow.ownerKey);
    owners.set(flow.ownerKey, owner);
    noteOwnerQueuedFlow(owner, flow, now);

    if (isPostCompactionDelegateFlow(flow)) {
      stagedPostCompaction += 1;
      owner.stagedPostCompaction += 1;
      continue;
    }

    pendingQueued += 1;
    owner.pendingQueued += 1;
    const state = decodeDelegateState(flow);
    if (!state) {
      invalidQueued += 1;
      owner.invalidQueued += 1;
      continue;
    }
    if (delegateDueAt(flow, state) <= now) {
      pendingRunnable += 1;
      owner.pendingRunnable += 1;
    } else {
      pendingScheduled += 1;
      owner.pendingScheduled += 1;
    }
  }

  const totalQueued = pendingQueued + stagedPostCompaction;
  const historyPoint: DiagnosticContinuationQueueHistoryPoint = {
    sampledAt: now,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    totalQueued,
    pendingRunnable,
    pendingScheduled,
    stagedPostCompaction,
    invalidQueued,
    enqueued: enqueuedSinceLastSample,
    drained: drainedSinceLastSample,
    failed: failedSinceLastSample,
  };
  continuationQueueDiagnosticsHistory.push(historyPoint);
  if (continuationQueueDiagnosticsHistory.length > CONTINUATION_QUEUE_HISTORY_LIMIT) {
    continuationQueueDiagnosticsHistory.splice(
      0,
      continuationQueueDiagnosticsHistory.length - CONTINUATION_QUEUE_HISTORY_LIMIT,
    );
  }
  continuationQueueDiagnosticsLastSampleAt = now;

  if (
    flows.length === 0 &&
    totalQueued === 0 &&
    enqueuedSinceLastSample === 0 &&
    drainedSinceLastSample === 0 &&
    failedSinceLastSample === 0
  ) {
    return undefined;
  }

  const rateFields =
    intervalMs !== undefined && intervalMs > 0
      ? {
          enqueueRatePerMinute: (enqueuedSinceLastSample * 60_000) / intervalMs,
          drainRatePerMinute: (drainedSinceLastSample * 60_000) / intervalMs,
          failedRatePerMinute: (failedSinceLastSample * 60_000) / intervalMs,
        }
      : {};

  return {
    sampledAt: now,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    totalQueued,
    pendingQueued,
    pendingRunnable,
    pendingScheduled,
    stagedPostCompaction,
    invalidQueued,
    enqueuedSinceLastSample,
    drainedSinceLastSample,
    failedSinceLastSample,
    ...rateFields,
    topQueues: [...owners.values()]
      .toSorted((a, b) => b.totalQueued - a.totalQueued || a.sessionKey.localeCompare(b.sessionKey))
      .slice(0, 8),
    queueDepthHistory: [...continuationQueueDiagnosticsHistory],
  };
}

registerDiagnosticContinuationQueueMetricsProvider(buildContinuationQueueDiagnostics);

function delegateDueAt(flow: TaskFlowRecord, state: PendingDelegateState): number {
  return flow.createdAt + (state.delayMs ?? 0);
}

function flowToDelegate(
  flow: TaskFlowRecord,
  state: PendingDelegateState,
): PendingContinuationDelegate {
  // Rehydrate runtime shape (mode-only) from the on-disk boolean flags.
  // silentWake takes precedence over silent
  // because on-disk rows may have both set (mode === "silent-wake" also
  // wrote silent in earlier encoders), and silent-wake is the more
  // specific mode.
  let mode: PendingContinuationDelegate["mode"];
  if (state.postCompaction === true) {
    mode = "post-compaction";
  } else if (state.silentWake === true) {
    mode = "silent-wake";
  } else if (state.silent === true) {
    mode = "silent";
  }
  return {
    task: state.task,
    ...(state.delayMs !== undefined ? { delayMs: state.delayMs } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(state.firstArmedAt !== undefined ? { firstArmedAt: state.firstArmedAt } : {}),
    ...(state.targetSessionKey ? { targetSessionKey: state.targetSessionKey } : {}),
    ...(state.targetSessionKeys && state.targetSessionKeys.length > 0
      ? { targetSessionKeys: state.targetSessionKeys }
      : {}),
    ...(state.fanoutMode ? { fanoutMode: state.fanoutMode } : {}),
    ...(state.traceparent ? { traceparent: state.traceparent } : {}),
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  };
}

// ---------------------------------------------------------------------------
// Pending delegates — enqueue/consume/count/cancel
// ---------------------------------------------------------------------------

/**
 * Enqueue a delegate from the `continue_delegate` tool.
 */
export function enqueuePendingDelegate(
  sessionKey: string,
  delegate: PendingContinuationDelegate,
): void {
  const isPostCompaction = delegate.mode === "post-compaction";
  createManagedTaskFlow({
    ownerKey: sessionKey,
    controllerId: isPostCompaction
      ? CONTINUATION_POST_COMPACTION_CONTROLLER_ID
      : CONTINUATION_DELEGATE_CONTROLLER_ID,
    notifyPolicy: "silent",
    goal: buildDelegateGoal(delegate),
    currentStep: isPostCompaction
      ? "Staged for release after compaction"
      : "Queued for continuation dispatch",
    stateJson: buildDelegateState(delegate),
  });
}

/**
 * Consume pending delegates for a session whose `delayMs` horizon has matured.
 *
 * Filters by `Date.now() >= flow.createdAt + (state.delayMs ?? 0)`. Matured
 * entries are finished with the `releasedAt` audit trail and returned in FIFO
 * order. Unmatured entries are left in `queued` state to be re-checked on the
 * next consume cycle (filter-at-consume; preserves `mode=silent` no-wake
 * semantics so a quiet-channel session is not woken solely to drain a delegate
 * whose horizon has not yet matured).
 *
 * Skips corrupt payloads via `failFlow`. Only pushes delegates where
 * `finishFlow` was applied (concurrency-safe).
 *
 * Callers that need to know when to retry the consume cycle in a quiet channel
 * should call `peekSoonestUnmaturedDelegateDueAt(sessionKey)` immediately after
 * this returns. Pairing avoids a separate query path.
 *
 * Maturity contract for downstream callers: each returned delegate has
 * already passed its `createdAt + delayMs` horizon. The `delayMs` field on
 * the returned object is historical metadata — useful for telemetry
 * discriminators — and MUST NOT be used as a fresh scheduling instruction.
 * Re-arming a `setTimeout(delayMs)` against a consumed delegate charges the
 * wait twice and drifts recipient drains by approximately the original delay.
 */
export function consumePendingDelegates(sessionKey: string): PendingContinuationDelegate[] {
  const delegates: PendingContinuationDelegate[] = [];
  const now = Date.now();

  for (const flow of listQueuedPendingFlows(sessionKey)) {
    const state = decodeDelegateState(flow);
    if (!state) {
      // Schema-drift / corrupt payload needs a live breadcrumb. failFlow
      // alone leaves the record in SQLite where
      // nobody looks until `openclaw status --deep`.
      log.warn(
        `[continuation:delegate-decode-failed] flowId=${flow.flowId} session=${sessionKey} raw=${JSON.stringify(flow.stateJson).slice(0, 200)}`,
      );
      failFlow({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: "Rejected invalid continuation payload",
        blockedSummary: "Pending continuation delegate payload could not be decoded.",
      });
      continue;
    }

    // Filter-at-consume: leave unmatured entries in `queued` so the next
    // response-finalize (or the hedge timer armed by the dispatch caller)
    // re-checks them. Honors `delayMs` on the tool path without threading a
    // wake-pathway timer (which would change `mode=silent` semantics).
    const dueAt = delegateDueAt(flow, state);
    if (now < dueAt) {
      continue;
    }

    const finished = finishFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: "Released to continuation scheduler",
      stateJson: { ...state, releasedAt: Date.now() },
    });
    if (!finished.applied || !finished.flow) {
      continue;
    }

    delegates.push(flowToDelegate(finished.flow, state));
  }

  return delegates;
}

/**
 * Peek the soonest `dueAt` (createdAt + delayMs) across queued, unmatured
 * pending delegates for a session.
 *
 * Returns `undefined` if there are no unmatured entries. Used by
 * `dispatchToolDelegates` to arm a hedge `setTimeout` so unmatured entries
 * still fire in fully-quiet channels where no further response-finalize
 * arrives.
 */
export function peekSoonestUnmaturedDelegateDueAt(sessionKey: string): number | undefined {
  const now = Date.now();
  let soonest: number | undefined;
  for (const flow of listQueuedPendingFlows(sessionKey)) {
    const state = decodeDelegateState(flow);
    if (!state) {
      continue;
    }
    const dueAt = delegateDueAt(flow, state);
    if (dueAt <= now) {
      continue;
    }
    if (soonest === undefined || dueAt < soonest) {
      soonest = dueAt;
    }
  }
  return soonest;
}

/**
 * Count pending delegates without consuming them.
 */
export function pendingDelegateCount(sessionKey: string): number {
  return listQueuedPendingFlows(sessionKey).length;
}

export function getContinuationDelegateQueueDepths(
  sessionKey: string,
  now = Date.now(),
): ContinuationDelegateQueueDepths {
  const pendingFlows = listQueuedPendingFlows(sessionKey);
  let pendingRunnable = 0;
  for (const flow of pendingFlows) {
    const state = decodeDelegateState(flow);
    if (state && delegateDueAt(flow, state) <= now) {
      pendingRunnable += 1;
    }
  }
  const stagedPostCompaction = listQueuedPostCompactionFlows(sessionKey).length;
  return {
    pendingQueued: pendingFlows.length,
    pendingRunnable,
    pendingScheduled: pendingFlows.length - pendingRunnable,
    stagedPostCompaction,
    totalQueued: pendingFlows.length + stagedPostCompaction,
  };
}

/**
 * Cancel all pending delegates for a session (both regular and post-compaction).
 */
export function cancelPendingDelegates(sessionKey: string): void {
  for (const flow of listTaskFlowsForOwnerKey(sessionKey).filter(
    (f) => isPendingDelegateFlow(f) || isPostCompactionDelegateFlow(f),
  )) {
    deleteTaskFlowRecordById(flow.flowId);
  }
}

// ---------------------------------------------------------------------------
// Post-compaction delegate staging
// ---------------------------------------------------------------------------

/**
 * Stage a delegate for release after compaction.
 */
export function stagePostCompactionDelegate(
  sessionKey: string,
  delegate: StagedPostCompactionDelegate,
): void {
  enqueuePendingDelegate(sessionKey, {
    task: delegate.task,
    mode: "post-compaction",
    firstArmedAt: delegate.firstArmedAt ?? delegate.stagedAt,
    ...(delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {}),
    ...(delegate.targetSessionKeys ? { targetSessionKeys: delegate.targetSessionKeys } : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(delegate.traceparent ? { traceparent: delegate.traceparent } : {}),
  });
}

/**
 * Consume staged post-compaction delegates. Same lifecycle as consumePendingDelegates.
 */
export function consumeStagedPostCompactionDelegates(
  sessionKey: string,
): PendingContinuationDelegate[] {
  const delegates: PendingContinuationDelegate[] = [];

  for (const flow of listQueuedPostCompactionFlows(sessionKey)) {
    const state = decodeDelegateState(flow);
    if (!state) {
      // Mirror the pending-path breadcrumb on the post-compaction consume lane.
      // Same schema-drift risk, same
      // dropped-work consequence.
      log.warn(
        `[continuation:post-compaction-decode-failed] flowId=${flow.flowId} session=${sessionKey} raw=${JSON.stringify(flow.stateJson).slice(0, 200)}`,
      );
      failFlow({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: "Rejected invalid post-compaction payload",
        blockedSummary: "Staged post-compaction delegate payload could not be decoded.",
      });
      continue;
    }

    const finished = finishFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: "Released after compaction",
      stateJson: { ...state, releasedAt: Date.now() },
    });
    if (!finished.applied) {
      continue;
    }

    delegates.push(flowToDelegate(flow, state));
  }

  return delegates;
}

export function stagedPostCompactionDelegateCount(sessionKey: string): number {
  return listQueuedPostCompactionFlows(sessionKey).length;
}

// ---------------------------------------------------------------------------
// Delayed continuation reservations (volatile, justified)
// Timer handles are process-scoped — timers themselves don't survive restart,
// so the reservation tracking doesn't need to either.
// ---------------------------------------------------------------------------

const delayedReservations = new Map<string, DelayedContinuationReservation[]>();

export function addDelayedContinuationReservation(
  sessionKey: string,
  reservation: DelayedContinuationReservation,
): void {
  const existing = delayedReservations.get(sessionKey);
  if (existing) {
    existing.push(reservation);
  } else {
    delayedReservations.set(sessionKey, [reservation]);
  }
}

export function takeDelayedContinuationReservation(
  sessionKey: string,
  reservationId: string,
): DelayedContinuationReservation | null {
  const list = delayedReservations.get(sessionKey);
  if (!list) {
    return null;
  }
  const idx = list.findIndex((r) => r.id === reservationId);
  if (idx === -1) {
    return null;
  }
  const [reservation] = list.splice(idx, 1);
  if (list.length === 0) {
    delayedReservations.delete(sessionKey);
  }
  return reservation;
}

export function delayedContinuationReservationCount(sessionKey: string): number {
  return delayedReservations.get(sessionKey)?.length ?? 0;
}

export function highestDelayedContinuationReservationHop(sessionKey: string): number {
  const list = delayedReservations.get(sessionKey);
  if (!list || list.length === 0) {
    return 0;
  }
  return Math.max(...list.map((r) => r.plannedHop));
}

export function clearDelayedContinuationReservations(sessionKey: string): void {
  delayedReservations.delete(sessionKey);
}

export function listDelayedContinuationReservations(
  sessionKey: string,
): DelayedContinuationReservation[] {
  return [...(delayedReservations.get(sessionKey) ?? [])];
}

export function removeDelayedContinuationReservation(
  sessionKey: string,
  reservationId: string,
): boolean {
  return takeDelayedContinuationReservation(sessionKey, reservationId) !== null;
}

// ---------------------------------------------------------------------------
// Continue-work request store intentionally stays absent: tool-based
// `continue_work` flows through the closure requestContinuation callback in
// agent-runner-execution.ts, then surfaces on the run outcome. Keeping this
// path single-sourced prevents a future side-channel Map from drifting.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetDelegateStoreForTests(): void {
  delayedReservations.clear();
  continuationQueueDiagnosticsLastSampleAt = undefined;
  continuationQueueDiagnosticsHistory.length = 0;
}
