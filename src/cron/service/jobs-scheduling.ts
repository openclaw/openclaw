/** Scheduling state and next-run computation for cron jobs. */
import crypto from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { isCronJobActive } from "../active-jobs.js";
import { coerceFiniteScheduleNumber } from "../schedule-number.js";
import { computeNextRunAtMs, computePreviousRunAtMs } from "../schedule.js";
import {
  cronSourceIdentity,
  createCronSourceIdentity,
  setCronSourceIdentity,
} from "../source-schedule.js";
import { resolveCronStaggerMs } from "../stagger.js";
import { hasCanonicalCronDeliveryMode } from "../store/delivery-codec.js";
import type { CronScheduleMaintenanceOptions } from "../store/runtime-worker.types.js";
import { resolveCronStreamBatching } from "../stream-schedule.js";
import type { CronJob, CronSchedule } from "../types.js";
import { autoDisableCronJob } from "./auto-disable.js";
import {
  computeOneShotNextRunAtMs,
  clearInvalidForcePreservedNextRun,
  isCronOneShotContinuationJob,
  resolveForcePreservedOneShotAtMs,
} from "./one-shot-schedule.js";
import type { CronJobPolicyContext, CronServiceState, DeferredCronNotifications } from "./state.js";
import { MIN_REFIRE_GAP_MS } from "./timer-execution-timeout.js";
import { hasPendingCronTriggerInterval } from "./trigger-interval.js";

/** A new timer receipt owns continuation; never reopen the interrupted occurrence. */
export function resolveCronRestartRetryAtMs(
  job: CronJob,
  startedAtMs: number,
  nowMs: number,
): number | undefined {
  if (
    !isJobEnabled(job) ||
    job.payload.kind !== "agentTurn" ||
    !["at", "every", "cron"].includes(job.schedule.kind)
  ) {
    return undefined;
  }
  // Publish the same retry floor that recurring-run admission will enforce.
  const delay =
    job.schedule.kind === "at"
      ? MIN_REFIRE_GAP_MS
      : errorBackoffMs(normalizeConsecutiveErrors(job.state.consecutiveErrors));
  return Math.max(nowMs, startedAtMs) + delay;
}

const STAGGER_OFFSET_CACHE_MAX = 4096;
const staggerOffsetCache = new Map<string, number>();
const TIME_SCHEDULE_STATE_FIELDS = [
  "startupCatchupAtMs",
  "pacedNextRunAtMs",
  "forcePreservedNextRunAtMs",
  "nextRunAtMs",
] as const;

export type CronScheduleOwnership = {
  reservations: ReadonlyMap<string, { markerAtMs: number; preserveWhenDisabled: boolean }>;
  isJobActive: (jobId: string) => boolean;
};

// A matching process reservation keeps its durable queued/running marker live;
// disabled jobs additionally require force-run ownership.
function ownsCronRunMarker(
  ownership: CronScheduleOwnership,
  jobId: string,
  markerAtMs: number,
  requireForce = false,
): boolean {
  const reservation = ownership.reservations.get(jobId);
  return (
    reservation?.markerAtMs === markerAtMs && (!requireForce || reservation.preserveWhenDisabled)
  );
}

export function normalizeStreamScheduleBounds(schedule: CronSchedule): CronSchedule {
  if (schedule.kind !== "stream") {
    return schedule;
  }
  const resolved = resolveCronStreamBatching(schedule);
  return {
    ...schedule,
    ...(schedule.batchMs !== undefined ? { batchMs: resolved.batchMs } : {}),
    ...(schedule.maxBatchBytes !== undefined ? { maxBatchBytes: resolved.maxBatchBytes } : {}),
  };
}

/** Default retry delays applied after consecutive cron execution errors. */
export const DEFAULT_ERROR_BACKOFF_SCHEDULE_MS = [
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];

function isFiniteTimestamp(value: unknown): value is number {
  return asDateTimestampMs(value) !== undefined;
}

/** Returns whether a stored next-run timestamp is finite and schedulable. */
export function hasScheduledNextRunAtMs(value: unknown): value is number {
  return isFiniteTimestamp(value) && value > 0;
}

/** Rejects outcome-generated schedule timestamps before they can persist or arm a timer. */
export function resolveNextRunAtMsOrDisable(params: {
  state: CronJobPolicyContext;
  job: CronJob;
  candidate: unknown;
  deferredNotifications: DeferredCronNotifications;
}): number | undefined {
  const nextRunAtMs = asDateTimestampMs(params.candidate);
  if (nextRunAtMs !== undefined && nextRunAtMs > 0) {
    return nextRunAtMs;
  }
  autoDisableCronJob({
    job: params.job,
    reason: "schedule-errors",
    atMs: params.state.deps.nowMs(),
    consecutiveErrors: 1,
    deferredNotifications: params.deferredNotifications,
  });
  return undefined;
}

/** Resolves the newest persisted cron run status while older state is still readable. */
export function resolveJobLastRunStatus(job: Pick<CronJob, "state">) {
  return job.state.lastRunStatus ?? job.state.lastStatus;
}

/** Resolves run end using the same persisted duration semantics as retry backoff. */
export function resolveJobLastRunEndedAtMs(job: Pick<CronJob, "state">): number | undefined {
  if (!isFiniteTimestamp(job.state.lastRunAtMs)) {
    return undefined;
  }
  const lastDurationMs =
    typeof job.state.lastDurationMs === "number" && Number.isFinite(job.state.lastDurationMs)
      ? Math.max(0, Math.floor(job.state.lastDurationMs))
      : 0;
  return job.state.lastRunAtMs + lastDurationMs;
}

/** Resolves the retry backoff delay for a one-based consecutive error count. */
export function errorBackoffMs(
  consecutiveErrors: number,
  scheduleMs = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
): number {
  const idx = Math.min(consecutiveErrors - 1, scheduleMs.length - 1);
  return expectDefined(scheduleMs[Math.max(0, idx)], "schedule ms entry at math.max(0, idx)");
}

export function normalizeConsecutiveErrors(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Returns the earliest retry timestamp after a failed cron run and its runtime duration. */
export function resolveJobErrorBackoffUntilMs(
  job: CronJob,
  scheduleMs = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
): number | undefined {
  if (resolveJobLastRunStatus(job) !== "error") {
    return undefined;
  }
  const lastEndedAtMs = resolveJobLastRunEndedAtMs(job);
  if (lastEndedAtMs === undefined) {
    return undefined;
  }
  const consecutiveErrors = normalizeConsecutiveErrors(job.state.consecutiveErrors);
  return asDateTimestampMs(lastEndedAtMs + errorBackoffMs(consecutiveErrors, scheduleMs));
}

function resolveStableCronOffsetMs(jobId: string, staggerMs: number) {
  if (staggerMs <= 1) {
    return 0;
  }
  const cacheKey = `${staggerMs}:${jobId}`;
  const cached = staggerOffsetCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const digest = crypto.createHash("sha256").update(jobId).digest();
  const offset = digest.readUInt32BE(0) % staggerMs;
  // The offset is deterministic, so FIFO eviction does not change future scheduling semantics.
  pruneMapToMaxSize(staggerOffsetCache, STAGGER_OFFSET_CACHE_MAX - 1);
  staggerOffsetCache.set(cacheKey, offset);
  return offset;
}

function computeStaggeredCronNextRunAtMs(job: CronJob, nowMs: number) {
  if (job.schedule.kind !== "cron") {
    return computeNextRunAtMs(job.schedule, nowMs);
  }

  const staggerMs = resolveCronStaggerMs(job.schedule);
  const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
  if (offsetMs <= 0) {
    return computeNextRunAtMs(job.schedule, nowMs);
  }

  // Shift the schedule cursor backwards by the per-job offset so we can still
  // target the current schedule window if its staggered slot has not passed yet.
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const baseNext = computeNextRunAtMs(job.schedule, cursorMs);
    if (baseNext === undefined) {
      return undefined;
    }
    const shifted = baseNext + offsetMs;
    if (isFiniteTimestamp(shifted) && shifted > nowMs) {
      return shifted;
    }
    cursorMs = Math.max(cursorMs + 1, baseNext + 1_000);
  }
  return undefined;
}

function computeStaggeredCronPreviousRunAtMs(job: CronJob, nowMs: number) {
  if (job.schedule.kind !== "cron") {
    return undefined;
  }

  const staggerMs = resolveCronStaggerMs(job.schedule);
  const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
  if (offsetMs <= 0) {
    return computePreviousRunAtMs(job.schedule, nowMs);
  }

  // Shift the cursor backwards by the same per-job offset used for next-run
  // math so previous-run lookup matches the effective staggered schedule.
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const basePrevious = computePreviousRunAtMs(job.schedule, cursorMs);
    if (basePrevious === undefined) {
      return undefined;
    }
    const shifted = basePrevious + offsetMs;
    if (isFiniteTimestamp(shifted) && shifted <= nowMs) {
      return shifted;
    }
    cursorMs = Math.max(0, basePrevious - 1_000);
  }
  return undefined;
}

function computeStaggeredCronPreviousRunAtOrBeforeMs(job: CronJob, nowMs: number) {
  const previous = computeStaggeredCronPreviousRunAtMs(job, nowMs);
  const probeMs = nowMs + 1_000;
  if (!isFiniteTimestamp(probeMs)) {
    return previous;
  }

  // Croner previous-run queries are strict-before and second-granular. Keep
  // the strict result, then probe past the current second to include a slot
  // exactly at now without losing the prior slot between boundaries.
  const boundary = computeStaggeredCronPreviousRunAtMs(job, probeMs);
  if (
    isFiniteTimestamp(boundary) &&
    boundary <= nowMs &&
    (!isFiniteTimestamp(previous) || boundary > previous)
  ) {
    return boundary;
  }
  return previous;
}

function isStaggeredCronRunAtMs(job: CronJob, runAtMs: number): boolean {
  if (job.schedule.kind !== "cron" || !isFiniteTimestamp(runAtMs)) {
    return false;
  }
  const previous = computeStaggeredCronPreviousRunAtOrBeforeMs(job, runAtMs);
  return previous === runAtMs;
}

function isStaleFutureCronSlot(job: CronJob, nowMs: number): boolean {
  const nextRun = job.state.nextRunAtMs;
  if (
    job.schedule.kind !== "cron" ||
    !hasScheduledNextRunAtMs(nextRun) ||
    nowMs >= nextRun ||
    typeof job.state.queuedAtMs === "number" ||
    typeof job.state.runningAtMs === "number"
  ) {
    return false;
  }

  // Retry and trigger floors can fall between expression slots.
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
  if (
    (backoffUntilMs !== undefined && nowMs < backoffUntilMs && nextRun <= backoffUntilMs) ||
    hasPendingCronTriggerInterval(job, nowMs)
  ) {
    return false;
  }
  let naturalNext: number | undefined;
  try {
    naturalNext = computeStaggeredCronNextRunAtMs(job, nowMs);
  } catch {
    return false;
  }
  if (!isFiniteTimestamp(naturalNext) || nextRun === naturalNext) {
    return false;
  }
  let isScheduledSlot;
  try {
    isScheduledSlot = isStaggeredCronRunAtMs(job, nextRun);
  } catch {
    return false;
  }
  if (isScheduledSlot) {
    return false;
  }
  if (nextRun < naturalNext) {
    return job.payload.kind !== "agentTurn";
  }
  let followingNaturalNext: number | undefined;
  try {
    followingNaturalNext = computeStaggeredCronNextRunAtMs(job, naturalNext);
  } catch {
    return false;
  }
  if (!isFiniteTimestamp(followingNaturalNext)) {
    return false;
  }
  const naturalIntervalMs = followingNaturalNext - naturalNext;
  return naturalIntervalMs > 0 && nextRun >= followingNaturalNext + naturalIntervalMs;
}

export function resolveEveryAnchorMs(params: {
  schedule: { everyMs: number; anchorMs?: number };
  fallbackAnchorMs: number;
}) {
  const coerced = coerceFiniteScheduleNumber(params.schedule.anchorMs);
  if (coerced !== undefined) {
    return Math.max(0, Math.floor(coerced));
  }
  if (isFiniteTimestamp(params.fallbackAnchorMs)) {
    return Math.max(0, Math.floor(params.fallbackAnchorMs));
  }
  return 0;
}

function hasInvalidExplicitEveryAnchor(schedule: { anchorMs?: number }): boolean {
  if (schedule.anchorMs === undefined) {
    return false;
  }
  const coerced = coerceFiniteScheduleNumber(schedule.anchorMs);
  return coerced === undefined || coerced < 0;
}

/** Finds an in-memory cron job or throws the public unknown-id error. */
export function findJobOrThrow(state: CronServiceState, id: string) {
  const job = state.store?.jobs.find((j) => j.id === id);
  if (!job) {
    throw new Error(`unknown cron job id: ${id}`);
  }
  return job;
}

/** Returns the effective enabled flag, defaulting missing values to enabled. */
export function isJobEnabled(job: Pick<CronJob, "enabled">): boolean {
  return job.enabled ?? true;
}

export function isTimeScheduledJob(job: Pick<CronJob, "schedule">): boolean {
  return (
    job.schedule.kind !== "on-exit" &&
    job.schedule.kind !== "stream" &&
    job.schedule.kind !== "event"
  );
}

/** Computes the next run timestamp for enabled jobs across every/at/cron schedules. */
export function computeJobNextRunAtMs(
  job: CronJob,
  nowMs: number,
  opts?: { preserveEveryAnchor?: boolean },
): number | undefined {
  if (!isJobEnabled(job)) {
    return undefined;
  }
  if (job.schedule.kind === "every") {
    if (hasInvalidExplicitEveryAnchor(job.schedule)) {
      return undefined;
    }
    const everyMsRaw = coerceFiniteScheduleNumber(job.schedule.everyMs);
    if (everyMsRaw === undefined) {
      return undefined;
    }
    const everyMs = Math.floor(everyMsRaw);
    if (everyMs < 1) {
      return undefined;
    }
    const fallbackAnchorMs = isFiniteTimestamp(job.createdAtMs) ? job.createdAtMs : nowMs;
    const anchorMs = resolveEveryAnchorMs({
      schedule: job.schedule,
      fallbackAnchorMs,
    });
    // A retry must not become a new anchor for the authored interval.
    const lastRunAtMs = opts?.preserveEveryAnchor ? undefined : job.state.lastRunAtMs;
    if (isFiniteTimestamp(lastRunAtMs) && lastRunAtMs >= anchorMs) {
      const nextFromLastRun = Math.floor(lastRunAtMs) + everyMs;
      if (!isFiniteTimestamp(nextFromLastRun)) {
        return undefined;
      }
      if (nextFromLastRun > nowMs) {
        return nextFromLastRun;
      }
    }
    const next = computeNextRunAtMs({ ...job.schedule, everyMs, anchorMs }, nowMs);
    return isFiniteTimestamp(next) ? next : undefined;
  }
  if (job.schedule.kind === "at") {
    return computeOneShotNextRunAtMs(job, resolveJobLastRunStatus(job));
  }
  const next = computeStaggeredCronNextRunAtMs(job, nowMs);
  if (next === undefined && job.schedule.kind === "cron") {
    const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
    return computeStaggeredCronNextRunAtMs(job, nextSecondMs);
  }
  return isFiniteTimestamp(next) ? next : undefined;
}

/** Computes the latest effective cron timestamp at or before the supplied time. */
export function computeJobPreviousRunAtOrBeforeMs(job: CronJob, nowMs: number): number | undefined {
  if (!isJobEnabled(job) || job.schedule.kind !== "cron") {
    return undefined;
  }
  return asDateTimestampMs(computeStaggeredCronPreviousRunAtOrBeforeMs(job, nowMs));
}

/** Maximum consecutive schedule errors before auto-disabling a job. */
const MAX_SCHEDULE_ERRORS = 3;

/** Records a schedule-computation failure and auto-disables after repeated errors. */
export function recordScheduleComputeError(params: {
  state: CronJobPolicyContext;
  job: CronJob;
  err: unknown;
  deferredNotifications: DeferredCronNotifications;
}): boolean {
  const { state, job, err } = params;
  const errorCount = (job.state.scheduleErrorCount ?? 0) + 1;
  const errText = formatErrorMessageWithCode(err);

  job.state.scheduleErrorCount = errorCount;
  job.state.nextRunAtMs = undefined;
  job.state.lastError = `schedule error: ${errText}`;

  if (errorCount >= MAX_SCHEDULE_ERRORS) {
    autoDisableCronJob({
      job,
      reason: "schedule-errors",
      atMs: state.deps.nowMs(),
      consecutiveErrors: errorCount,
      deferredNotifications: params.deferredNotifications,
    });
    state.deps.log.error(
      { jobId: job.id, name: job.name, errorCount, err: errText },
      "cron: auto-disabled job after repeated schedule errors",
    );
  } else {
    state.deps.log.warn(
      { jobId: job.id, name: job.name, errorCount, err: errText },
      "cron: failed to compute next run for job (skipping)",
    );
  }

  return true;
}

function normalizeJobTickState(params: {
  state: CronJobPolicyContext;
  job: CronJob;
  ownership: CronScheduleOwnership;
}): {
  changed: boolean;
  skip: boolean;
} {
  const { job, ownership } = params;
  let changed = false;

  if (!job.state) {
    job.state = {};
    changed = true;
  }

  if (
    (job.schedule.kind === "stream" || job.schedule.kind === "event") &&
    !cronSourceIdentity(job)?.trim()
  ) {
    // Identity is store-owned state. A hand-imported or pre-identity row must
    // not reach the watcher (which fails closed on a missing identity) or
    // admission (which would reject every batch); assign one like any other
    // repairable tick state.
    setCronSourceIdentity(job, createCronSourceIdentity());
    changed = true;
  }

  // Event schedules cannot retain a timed slot, including one preserved by a force run.
  if (
    (!isJobEnabled(job) && job.state.forcePreservedNextRunAtMs !== job.state.nextRunAtMs) ||
    !isTimeScheduledJob(job)
  ) {
    for (const key of TIME_SCHEDULE_STATE_FIELDS) {
      if (
        key === "forcePreservedNextRunAtMs" &&
        resolveForcePreservedOneShotAtMs(job) !== undefined
      ) {
        continue;
      }
      if (job.state[key] !== undefined) {
        job.state[key] = undefined;
        changed = true;
      }
    }
  }
  if (!isJobEnabled(job)) {
    if (
      job.state.runningAtMs !== undefined &&
      !ownsCronRunMarker(ownership, job.id, job.state.runningAtMs, true) &&
      !ownership.isJobActive(job.id)
    ) {
      Object.assign(job.state, { runningAtMs: undefined, runningReceiptId: undefined });
      delete job.state.runningScheduleChangeId;
      changed = true;
    }
    return { changed, skip: true };
  }

  if (!hasScheduledNextRunAtMs(job.state.nextRunAtMs) && job.state.nextRunAtMs !== undefined) {
    job.state.nextRunAtMs = undefined;
    changed = true;
  }

  changed = clearInvalidForcePreservedNextRun(job) || changed;

  return { changed, skip: false };
}

export function recomputeJobNextRunAtMs(params: {
  state: CronJobPolicyContext;
  job: CronJob;
  nowMs: number;
  deferredNotifications: DeferredCronNotifications;
  skipScheduleErrorHandling?: boolean;
}) {
  let changed = false;
  try {
    let newNext = computeJobNextRunAtMs(params.job, params.nowMs);
    if (
      params.job.schedule.kind !== "at" &&
      resolveJobLastRunStatus(params.job) === "error" &&
      isFiniteTimestamp(params.job.state.lastRunAtMs)
    ) {
      const backoffFloor = resolveJobErrorBackoffUntilMs(
        params.job,
        DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
      );
      if (newNext !== undefined) {
        newNext = backoffFloor !== undefined ? Math.max(newNext, backoffFloor) : newNext;
      }
    }
    if (params.job.state.nextRunAtMs !== newNext) {
      params.job.state.nextRunAtMs = newNext;
      changed = true;
    }
    // Clear schedule error count on successful computation.
    if (params.job.state.scheduleErrorCount) {
      params.job.state.scheduleErrorCount = undefined;
      changed = true;
    }
  } catch (err) {
    if (params.skipScheduleErrorHandling) {
      return false;
    }
    if (
      recordScheduleComputeError({
        state: params.state,
        job: params.job,
        err,
        deferredNotifications: params.deferredNotifications,
      })
    ) {
      changed = true;
    }
  }
  return changed;
}

/** Repairs schedule state while preserving due slots that have not executed. */
type CronMaintenanceOptions = CronScheduleMaintenanceOptions & {
  deferredNotifications: DeferredCronNotifications;
};

function isExpiredCronScheduleRepairCandidate(
  job: CronJob,
  nowMs: number,
  active: boolean,
): boolean {
  const nextRunAtMs = job.state.nextRunAtMs;
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
  return (
    hasScheduledNextRunAtMs(nextRunAtMs) &&
    nowMs >= nextRunAtMs &&
    typeof job.state.queuedAtMs !== "number" &&
    typeof job.state.runningAtMs !== "number" &&
    !active &&
    job.state.startupCatchupAtMs !== nextRunAtMs &&
    job.state.forcePreservedNextRunAtMs !== nextRunAtMs &&
    ((isFiniteTimestamp(job.state.lastRunAtMs) && job.state.lastRunAtMs >= nextRunAtMs) ||
      (backoffUntilMs !== undefined && nowMs < backoffUntilMs && nextRunAtMs < backoffUntilMs))
  );
}

/** Avoid acquiring the writer when the persisted schedules need no repair. */
export function needsCronTimerMaintenance(
  job: CronJob,
  nowMs: number,
  options?: CronScheduleMaintenanceOptions,
): boolean {
  if (hasActiveCronRun(job, false)) {
    return false;
  }
  if (!isTimeScheduledJob(job)) {
    return TIME_SCHEDULE_STATE_FIELDS.some((key) => job.state[key] !== undefined);
  }
  if (!isJobEnabled(job)) {
    return (
      job.state.forcePreservedNextRunAtMs !== job.state.nextRunAtMs &&
      TIME_SCHEDULE_STATE_FIELDS.some((key) => job.state[key] !== undefined)
    );
  }
  return (
    (options?.recomputeExpired !== false &&
      isExpiredCronScheduleRepairCandidate(job, nowMs, false)) ||
    (options?.repairFutureCronNextRunAtMs !== false && isStaleFutureCronSlot(job, nowMs)) ||
    (isJobEnabled(job) && !hasScheduledNextRunAtMs(job.state.nextRunAtMs))
  );
}

export function recomputeSingleJobForMaintenance(
  state: CronJobPolicyContext,
  job: CronJob,
  opts: CronMaintenanceOptions,
  ownership: CronScheduleOwnership,
): boolean {
  const now = opts.nowMs ?? state.deps.nowMs();
  const tick = normalizeJobTickState({ state, job, ownership });
  let changed = tick.changed;
  if (tick.skip) {
    return changed;
  }
  const recomputeExpired = opts.recomputeExpired ?? false;
  const repairFutureCronNextRunAtMs = opts.repairFutureCronNextRunAtMs ?? true;
  const recomputeJob = () =>
    recomputeJobNextRunAtMs({
      state,
      job,
      nowMs: now,
      deferredNotifications: opts.deferredNotifications,
      skipScheduleErrorHandling: opts.skipScheduleErrorHandling,
    });
  const startupCatchupAtMs = job.state.startupCatchupAtMs;
  const pacedNextRunAtMs = job.state.pacedNextRunAtMs;
  const nextRunAtMs = job.state.nextRunAtMs;
  const hasForcePreservedNextRun =
    isFiniteTimestamp(job.state.forcePreservedNextRunAtMs) &&
    hasScheduledNextRunAtMs(nextRunAtMs) &&
    job.state.forcePreservedNextRunAtMs === nextRunAtMs;
  const hasPendingStartupCatchup =
    isFiniteTimestamp(startupCatchupAtMs) &&
    hasScheduledNextRunAtMs(nextRunAtMs) &&
    startupCatchupAtMs === nextRunAtMs;
  if (startupCatchupAtMs !== undefined && !hasPendingStartupCatchup) {
    job.state.startupCatchupAtMs = undefined;
    changed = true;
  }
  const hasPendingPacedNextRun =
    isFiniteTimestamp(pacedNextRunAtMs) &&
    hasScheduledNextRunAtMs(nextRunAtMs) &&
    pacedNextRunAtMs === nextRunAtMs &&
    (now < pacedNextRunAtMs ||
      isCronOneShotContinuationJob(job) ||
      opts.preserveExpiredPacedNextRunJobId === job.id);
  if (pacedNextRunAtMs !== undefined && !hasPendingPacedNextRun) {
    job.state.pacedNextRunAtMs = undefined;
    changed = true;
  }

  if (!hasScheduledNextRunAtMs(job.state.nextRunAtMs)) {
    changed = recomputeJob() || changed;
  } else if (
    repairFutureCronNextRunAtMs &&
    !hasPendingStartupCatchup &&
    !hasPendingPacedNextRun &&
    !hasForcePreservedNextRun &&
    isStaleFutureCronSlot(job, now)
  ) {
    changed = recomputeJob() || changed;
  } else if (
    recomputeExpired &&
    isExpiredCronScheduleRepairCandidate(job, now, ownership.isJobActive(job.id))
  ) {
    changed = recomputeJob() || changed;
  }
  return changed;
}

/** Returns the next enabled wake timestamp from committed job rows. */
export function nextWakeAtMs(state: CronServiceState): number | undefined {
  let nextWake: number | undefined;
  for (const job of state.store?.jobs ?? []) {
    if (
      isJobEnabled(job) &&
      hasCanonicalCronDeliveryMode(job.delivery) &&
      isTimeScheduledJob(job) &&
      hasScheduledNextRunAtMs(job.state.nextRunAtMs)
    ) {
      nextWake = Math.min(nextWake ?? Infinity, job.state.nextRunAtMs);
    }
  }
  return nextWake;
}

/** Applies one canonical server-authored authority envelope to a tool-bearing job. */
export function hasActiveCronRun(job: Pick<CronJob, "id" | "state">, activeInProcess?: boolean) {
  return (
    typeof job.state.queuedAtMs === "number" ||
    typeof job.state.runningAtMs === "number" ||
    (activeInProcess ?? isCronJobActive(job.id))
  );
}
