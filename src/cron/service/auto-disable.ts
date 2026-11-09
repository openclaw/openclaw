/** Shared state and owner-notification policy for cron auto-disable transitions. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isCronConfigurationRefusal } from "../configuration-refusal.js";
import { cronFailureDetailLines } from "../failure-notification-text.js";
import type { CronFailureNotificationDetail, CronJob, CronJobState } from "../types.js";
import { cronNotificationJob } from "./notification-intents.js";
import type { DeferredCronNotifications } from "./state.js";

type CronAutoDisableReason = NonNullable<CronJobState["autoDisabled"]>["reason"];

/**
 * Run failures get more room than schedule errors (10 vs. 3) because provider
 * and network errors are often transient.
 */
const MAX_CONSECUTIVE_RUN_FAILURES = 10;

function autoDisableReasonLabel(reason: CronAutoDisableReason): string {
  return reason === "consecutive-failures" ? "run failures" : "schedule errors";
}

/** The safety notice text: the same words reach the failure route and the owning agent. */
export function buildCronAutoDisableNotice(params: {
  job: Pick<CronJob, "id" | "name" | "state">;
  reason: CronAutoDisableReason;
  consecutiveErrors: number;
  /** Closed detail of the run failure that disabled the job. */
  failureNotificationDetail?: CronFailureNotificationDetail;
}): string {
  const { job } = params;
  const name = truncateUtf16Safe((job.name || job.id).replace(/\s+/g, " ").trim(), 120);
  const runFailure = params.reason === "consecutive-failures";
  const errorReason = runFailure ? job.state.lastErrorReason : undefined;
  const detail = runFailure ? params.failureNotificationDetail : undefined;
  return [
    isCronConfigurationRefusal(detail)
      ? `⚠️ Automation "${name}" was paused because retrying cannot fix its last run failure.`
      : `⚠️ Automation "${name}" was auto-disabled after ${params.consecutiveErrors} consecutive ${autoDisableReasonLabel(params.reason)}.`,
    ...cronFailureDetailLines(errorReason, detail),
    `Fix the underlying cause, then run \`openclaw automations enable ${job.id}\` to re-enable it.`,
  ].join("\n");
}

/** Queues the in-app safety notice for the owning agent. */
export function queueCronAutoDisableNotification(params: {
  job: CronJob;
  reason: CronAutoDisableReason;
  consecutiveErrors: number;
  failureNotificationDetail?: CronFailureNotificationDetail;
  deferredNotifications: DeferredCronNotifications;
}): void {
  params.deferredNotifications.push({
    kind: "auto-disabled",
    job: cronNotificationJob(params.job),
    text: buildCronAutoDisableNotice(params),
  });
}

/** Records one canonical auto-disable fact and queues its owning-agent notification. */
export function autoDisableCronJob(params: {
  job: CronJob;
  reason: CronAutoDisableReason;
  atMs: number;
  consecutiveErrors: number;
  failureNotificationDetail?: CronFailureNotificationDetail;
  deferredNotifications: DeferredCronNotifications;
  /** A terminal one-shot is already disabled when its notification is finalized. */
  terminalOneShot?: boolean;
  notify?: boolean;
}): boolean {
  const { job } = params;
  if ((!job.enabled && !params.terminalOneShot) || job.state.autoDisabled) {
    return false;
  }

  job.enabled = false;
  job.state.nextRunAtMs = undefined;
  job.state.autoDisabled = {
    reason: params.reason,
    atMs: params.atMs,
    consecutiveErrors: params.consecutiveErrors,
  };

  if (params.notify === false) {
    return true;
  }
  queueCronAutoDisableNotification(params);
  return true;
}

/**
 * Auto-disables only time-based recurring jobs once their run-error streak reaches the limit.
 * A setup refusal that retries cannot change pauses the job on its first failure.
 */
export function maybeAutoDisableCronJobAfterRunFailure(params: {
  job: CronJob;
  atMs: number;
  failureNotificationDetail?: CronFailureNotificationDetail;
  deferredNotifications: DeferredCronNotifications;
  /** The caller owns the notice when the failure route decides who is told first. */
  notify?: boolean;
}): boolean {
  const consecutiveErrors = params.job.state.consecutiveErrors ?? 0;
  if (
    (params.job.schedule.kind !== "cron" && params.job.schedule.kind !== "every") ||
    consecutiveErrors <
      (isCronConfigurationRefusal(params.failureNotificationDetail)
        ? 1
        : MAX_CONSECUTIVE_RUN_FAILURES)
  ) {
    return false;
  }
  return autoDisableCronJob({
    ...params,
    reason: "consecutive-failures",
    consecutiveErrors,
  });
}
