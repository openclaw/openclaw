// Reviewer-failure recovery planner (D-GAP-4).
//
// In the OpenClaw multitasking operator loop each worker run is followed by a
// reviewer run that inspects the worker's output before the result is reported
// to the owner. Two failures can land at the reviewer stage and they need
// different recovery:
//
//   - worker_failed       — the work under review failed. The reviewer has
//                           nothing to judge, so the loop reports the worker
//                           failure to the owner (`worker-report`). It is not
//                           a reviewer fault and never briefs as one.
//   - reviewer_run_failed — the reviewer run itself crashed/errored (timeout,
//                           transport fault, harness crash) without producing a
//                           verdict. The work is still unjudged, so the loop
//                           retries the reviewer (`reviewer-retry`) until a
//                           small budget is spent, then escalates.
//
// This module is the seam the operator loop calls when a reviewer-stage failure
// is observed. It mirrors the thin-seam style of `worker-completion-wake.ts`
// and the once-per-occurrence briefing style of `briefing-events.ts`, and does
// three things:
//
//   1. Records the failure under a distinct change-kind so the AgentTaskEvent
//      journal separates reviewer-run faults from worker faults.
//   2. Binds the operator-loop supersession filter to a real PlanAction: a
//      reviewer failure from a superseded loop generation yields `none` (a
//      newer pass already owns the worker), otherwise it yields a real
//      `reviewer-retry` action carrying the next attempt number — or `escalate`
//      once the retry budget is exhausted.
//   3. Briefs Telegram exactly once per failed-reviewer event through an
//      injected emitter (the operator surface binds it to the briefing bus), so
//      duplicate re-emits of the same reviewer failure do not spam the owner or
//      double-count retries.

import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export const REVIEWER_RUN_FAILED_CHANGE_KIND = "reviewer_run_failed" as const;
export const WORKER_FAILURE_CHANGE_KIND = "worker_failed" as const;

export type ReviewerFailureKind =
  | typeof REVIEWER_RUN_FAILED_CHANGE_KIND
  | typeof WORKER_FAILURE_CHANGE_KIND;

/** Reviewer retries attempted before the loop escalates to the owner. */
export const DEFAULT_MAX_REVIEWER_RETRIES = 2;

export type ReviewerFailureEvent = {
  /** Distinguishes a reviewer-run crash from a worker failure. */
  kind: ReviewerFailureKind;
  /** Stable id of the worker whose output is under review. Required. */
  workerId: string;
  /**
   * Stable id of the reviewer run that failed. Required for
   * `reviewer_run_failed`; ignored for `worker_failed`.
   */
  reviewerRunId?: string;
  /**
   * Operator-loop plan generation that produced this run. A newer generation
   * supersedes retries planned by older ones. Defaults to 0.
   */
  generation?: number;
  /** Owner session key to wake for retry / report / escalation. */
  sessionKey?: string | null;
  /** One-line human summary used in the briefing / report. */
  summary?: string;
  /** Free-form failure detail (error message, exit reason). */
  detail?: string;
};

export type PlanActionSkipReason =
  | "superseded"
  | "duplicate"
  | "no_worker_id"
  | "missing_reviewer_run_id";

export type PlanAction =
  | {
      type: "reviewer-retry";
      workerId: string;
      reviewerRunId: string;
      /** 1-based number of the retry the loop should now schedule. */
      attempt: number;
      generation: number;
    }
  | {
      type: "escalate";
      workerId: string;
      reason: "reviewer_retry_exhausted";
      /** Total reviewer failures seen in this generation. */
      attempts: number;
      generation: number;
    }
  | {
      type: "worker-report";
      workerId: string;
      generation: number;
    }
  | { type: "none"; reason: PlanActionSkipReason };

export type ReviewerFailedBriefing = {
  type: "briefing.reviewer_failed";
  workerId: string;
  reviewerRunId: string;
  generation: number;
  /** Recovery chosen for this failure. */
  recovery: "reviewer-retry" | "escalate";
  /** Retry number being scheduled, or the exhausted count on escalation. */
  attempt: number;
  maxRetries: number;
  sessionKey?: string;
  summary?: string;
  detail?: string;
};

/**
 * Transport seam for the once-per-event Telegram briefing. The operator
 * surface binds this to the briefing bus (`briefing.reviewer_failed`); tests
 * pass a capturing callback. Omitting it skips the notification but still
 * records the failure and computes the recovery action.
 */
export type ReviewerFailedBriefingEmitter = (briefing: ReviewerFailedBriefing) => void;

export type PlanReviewerFailureOptions = {
  /** Reviewer retries before escalation. Defaults to {@link DEFAULT_MAX_REVIEWER_RETRIES}. */
  maxRetries?: number;
  /** Emitter for the once-per-event Telegram briefing. */
  emitBriefing?: ReviewerFailedBriefingEmitter;
};

export type ReviewerFailureRecoveryResult = {
  /** Next operator-loop action for this failure. */
  action: PlanAction;
  /** Distinct change-kind tag for the AgentTaskEvent journal. */
  changeKind: ReviewerFailureKind;
  /** Whether a Telegram briefing was emitted on this call. */
  briefed: boolean;
};

export type ReviewerFailureStats = {
  reviewer_run_failed: number;
  worker_failed: number;
};

type WorkerReviewState = {
  /** Highest loop generation observed for this worker. */
  latestGeneration: number;
  /** Reviewer failures counted within `latestGeneration`. */
  attempts: number;
};

type ReviewerFailureRecoveryState = {
  byWorker: Map<string, WorkerReviewState>;
  /** Event keys already handled — gates double-count and double-brief. */
  handled: Set<string>;
  counts: ReviewerFailureStats;
};

const REVIEWER_FAILURE_RECOVERY_STATE_KEY = Symbol.for("openclaw.reviewerFailureRecovery.state.v1");

// Operator loops are bounded in practice; these caps protect a long-lived
// gateway from unbounded growth if a caller fans out unexpectedly.
const MAX_TRACKED_WORKERS = 1024;
const MAX_TRACKED_EVENTS = 4096;

function getState(): ReviewerFailureRecoveryState {
  return resolveGlobalSingleton<ReviewerFailureRecoveryState>(
    REVIEWER_FAILURE_RECOVERY_STATE_KEY,
    () => ({
      byWorker: new Map<string, WorkerReviewState>(),
      handled: new Set<string>(),
      counts: { reviewer_run_failed: 0, worker_failed: 0 },
    }),
  );
}

// Drop the oldest entry once a tracking collection exceeds its cap; insertion
// order is preserved by Set/Map iteration.
function capSet(set: Set<string>, max: number): void {
  if (set.size <= max) {
    return;
  }
  const oldest = set.values().next().value;
  if (oldest !== undefined) {
    set.delete(oldest);
  }
}

function capWorkerMap(map: Map<string, WorkerReviewState>, max: number): void {
  if (map.size <= max) {
    return;
  }
  const oldest = map.keys().next().value;
  if (oldest !== undefined) {
    map.delete(oldest);
  }
}

function normalizeGeneration(generation: number | undefined): number {
  return typeof generation === "number" && Number.isFinite(generation) ? generation : 0;
}

/**
 * Record the latest operator-loop generation seen for a worker. Advancing the
 * generation resets the reviewer retry budget — a newer loop pass starts the
 * review afresh. Safe to call before {@link planReviewerFailureRecovery}; the
 * planner calls it internally as well.
 */
export function observeGeneration(workerId: string, generation: number): void {
  const id = normalizeOptionalString(workerId);
  if (!id) {
    return;
  }
  const gen = normalizeGeneration(generation);
  const state = getState();
  const existing = state.byWorker.get(id);
  if (!existing) {
    state.byWorker.set(id, { latestGeneration: gen, attempts: 0 });
    capWorkerMap(state.byWorker, MAX_TRACKED_WORKERS);
    return;
  }
  if (gen > existing.latestGeneration) {
    existing.latestGeneration = gen;
    existing.attempts = 0;
  }
}

/**
 * Operator-loop supersession filter: true when an action from `generation` is
 * stale because a newer loop pass already owns this worker. The planner uses
 * this to gate whether a reviewer failure becomes a real `reviewer-retry`.
 */
export function isSupersededGeneration(workerId: string, generation: number): boolean {
  const id = normalizeOptionalString(workerId);
  if (!id) {
    return false;
  }
  const existing = getState().byWorker.get(id);
  if (!existing) {
    return false;
  }
  return normalizeGeneration(generation) < existing.latestGeneration;
}

function buildResult(
  action: PlanAction,
  changeKind: ReviewerFailureKind,
  briefed: boolean,
): ReviewerFailureRecoveryResult {
  return { action, changeKind, briefed };
}

function planWorkerFailure(workerId: string, generation: number): ReviewerFailureRecoveryResult {
  // A worker failure is a terminal outcome for this generation — advance the
  // generation so any in-flight reviewer retry from an older pass is superseded.
  observeGeneration(workerId, generation);
  if (isSupersededGeneration(workerId, generation)) {
    return buildResult({ type: "none", reason: "superseded" }, WORKER_FAILURE_CHANGE_KIND, false);
  }
  getState().counts.worker_failed += 1;
  return buildResult(
    { type: "worker-report", workerId, generation },
    WORKER_FAILURE_CHANGE_KIND,
    false,
  );
}

function planReviewerFailure(
  event: ReviewerFailureEvent,
  workerId: string,
  generation: number,
  opts: PlanReviewerFailureOptions,
): ReviewerFailureRecoveryResult {
  const reviewerRunId = normalizeOptionalString(event.reviewerRunId);
  if (!reviewerRunId) {
    return buildResult(
      { type: "none", reason: "missing_reviewer_run_id" },
      REVIEWER_RUN_FAILED_CHANGE_KIND,
      false,
    );
  }

  // Supersession is checked before counting so a stale retry never consumes the
  // budget of the live generation.
  if (isSupersededGeneration(workerId, generation)) {
    return buildResult(
      { type: "none", reason: "superseded" },
      REVIEWER_RUN_FAILED_CHANGE_KIND,
      false,
    );
  }

  const state = getState();
  const eventKey = `${workerId}:${generation}:${reviewerRunId}`;
  if (state.handled.has(eventKey)) {
    // Duplicate terminal event (re-emit, retry race, double-finalize). Stay
    // idempotent: no second retry, no second briefing.
    return buildResult(
      { type: "none", reason: "duplicate" },
      REVIEWER_RUN_FAILED_CHANGE_KIND,
      false,
    );
  }

  observeGeneration(workerId, generation);
  const worker = state.byWorker.get(workerId);
  if (!worker) {
    // observeGeneration always seeds the entry; this is unreachable in practice
    // but keeps the type non-nullable without a non-null assertion.
    return buildResult(
      { type: "none", reason: "no_worker_id" },
      REVIEWER_RUN_FAILED_CHANGE_KIND,
      false,
    );
  }

  worker.attempts += 1;
  const attempts = worker.attempts;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_REVIEWER_RETRIES;
  const canRetry = attempts <= maxRetries;

  const action: PlanAction = canRetry
    ? { type: "reviewer-retry", workerId, reviewerRunId, attempt: attempts, generation }
    : {
        type: "escalate",
        workerId,
        reason: "reviewer_retry_exhausted",
        attempts,
        generation,
      };

  state.counts.reviewer_run_failed += 1;
  state.handled.add(eventKey);
  capSet(state.handled, MAX_TRACKED_EVENTS);

  const briefed = briefReviewerFailure(event, {
    workerId,
    reviewerRunId,
    generation,
    recovery: canRetry ? "reviewer-retry" : "escalate",
    attempt: attempts,
    maxRetries,
    emit: opts.emitBriefing,
  });

  return buildResult(action, REVIEWER_RUN_FAILED_CHANGE_KIND, briefed);
}

function briefReviewerFailure(
  event: ReviewerFailureEvent,
  ctx: {
    workerId: string;
    reviewerRunId: string;
    generation: number;
    recovery: "reviewer-retry" | "escalate";
    attempt: number;
    maxRetries: number;
    emit?: ReviewerFailedBriefingEmitter;
  },
): boolean {
  if (!ctx.emit) {
    return false;
  }
  const sessionKey = normalizeOptionalString(event.sessionKey);
  const summary = normalizeOptionalString(event.summary);
  const detail = normalizeOptionalString(event.detail);
  const briefing: ReviewerFailedBriefing = {
    type: "briefing.reviewer_failed",
    workerId: ctx.workerId,
    reviewerRunId: ctx.reviewerRunId,
    generation: ctx.generation,
    recovery: ctx.recovery,
    attempt: ctx.attempt,
    maxRetries: ctx.maxRetries,
    ...(sessionKey ? { sessionKey } : {}),
    ...(summary ? { summary } : {}),
    ...(detail ? { detail } : {}),
  };
  try {
    ctx.emit(briefing);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(
      `[reviewer-failure-recovery] briefing emit failed worker=${ctx.workerId} run=${ctx.reviewerRunId}: ${message}`,
    );
  }
  return true;
}

/**
 * Plan recovery for a reviewer-stage failure. Discriminates worker failures
 * from reviewer-run failures, applies the operator-loop supersession filter and
 * retry budget, and briefs Telegram exactly once per failed-reviewer event.
 *
 * Idempotent per `(workerId, generation, reviewerRunId)` for the lifetime of
 * the process: duplicate reviewer failures collapse to `none{duplicate}`.
 */
export function planReviewerFailureRecovery(
  event: ReviewerFailureEvent,
  opts: PlanReviewerFailureOptions = {},
): ReviewerFailureRecoveryResult {
  const workerId = normalizeOptionalString(event.workerId);
  if (!workerId) {
    return buildResult({ type: "none", reason: "no_worker_id" }, event.kind, false);
  }
  const generation = normalizeGeneration(event.generation);

  if (event.kind === WORKER_FAILURE_CHANGE_KIND) {
    return planWorkerFailure(workerId, generation);
  }
  return planReviewerFailure(event, workerId, generation, opts);
}

/** Snapshot of recorded failures by kind. Reviewer faults are counted apart from worker faults. */
export function getReviewerFailureStats(): ReviewerFailureStats {
  const { counts } = getState();
  return { ...counts };
}

export function resetReviewerFailureRecoveryStateForTests(): void {
  const state = getState();
  state.byWorker.clear();
  state.handled.clear();
  state.counts.reviewer_run_failed = 0;
  state.counts.worker_failed = 0;
}
