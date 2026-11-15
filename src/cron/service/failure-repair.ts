/**
 * Owner-conversation repair of a failing automation. Repair answers "can the owning agent
 * fix this?", so it starts on the first failure of a streak, independently of the alert
 * policy that decides when a person is told.
 */
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../agents/timeout.js";
import type { CronJob } from "../types.js";
import { buildCronFailureRepairBrief } from "./failure-repair-brief.js";
import { isJobEnabled } from "./jobs-scheduling.js";
import { cronNotificationJob, type CronNotificationIntent } from "./notification-intents.js";
import type { CronJobPolicyContext, DeferredCronNotifications } from "./state.js";

type CronFailureRepair = NonNullable<CronJob["state"]["failureRepair"]>;

/** Command jobs and on-exit or stream schedules are operator-only; they alert instead. */
export function hasFailureRepairOwner(
  job: Partial<Pick<CronJob, "owner" | "payload" | "schedule">>,
): boolean {
  return Boolean(
    job.owner?.sessionKey?.trim() &&
    job.payload &&
    job.payload.kind !== "command" &&
    job.schedule &&
    job.schedule.kind !== "on-exit" &&
    job.schedule.kind !== "stream",
  );
}

/** A terminal one-shot is already disabled, but its owner can still finish the work. */
export function canStartCronFailureRepair(job: CronJob, terminalOneShot: boolean): boolean {
  return hasFailureRepairOwner(job) && (terminalOneShot || isJobEnabled(job));
}

/**
 * Only a run that started after the repair settled, or after its deadline passed, can show
 * whether the repair worked; an earlier run failing proves nothing.
 */
export function failedRunVerifiesCronRepair(repair: CronFailureRepair, runStartedAtMs: number) {
  return runStartedAtMs > (repair.settledAtMs ?? repair.deadlineAtMs);
}

/** Records the streak's one repair and asks the owner conversation to run it. */
export function startCronFailureRepair(
  state: CronJobPolicyContext,
  params: {
    job: CronJob;
    error?: string;
    scope: "run" | "trigger";
    terminalOneShot: boolean;
    /** Sent instead when the repair turn cannot start. */
    fallback?: Extract<CronNotificationIntent, { kind: "failure-repair" }>["fallback"];
    deferredNotifications: DeferredCronNotifications;
  },
): void {
  const { job } = params;
  const startedAtMs = state.deps.nowMs();
  job.state.failureRepair = {
    startedAtMs,
    deadlineAtMs: startedAtMs + (state.deps.failureRepairTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS),
  };
  params.deferredNotifications.push({
    kind: "failure-repair",
    job: cronNotificationJob(job),
    startedAtMs,
    ...(params.fallback ? { fallback: params.fallback } : {}),
    text: buildCronFailureRepairBrief({
      job,
      consecutiveErrors: job.state.consecutiveErrors ?? 1,
      error: params.error,
      errorReason: job.state.lastErrorReason,
      scope: params.scope,
      terminal: params.terminalOneShot,
    }),
  });
}
