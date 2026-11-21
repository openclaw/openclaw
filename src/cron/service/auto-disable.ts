// The scheduler's writer of recorded stops. A job off without `state.autoDisabled` was turned
// off by its owner, finished, or predates the record.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { cronFailureDetailLines } from "../failure-notification-text.js";
import type { CronFailureNotificationDetail, CronJob, CronJobState } from "../types.js";
import { cronNotificationJob, resolveCronNotificationQueueOwner } from "./notification-intents.js";
import type { CronJobPolicyContext, DeferredCronNotifications } from "./state.js";

type CronAutoDisabled = NonNullable<CronJobState["autoDisabled"]>;

type CronStopNotice = {
  failureNotificationDetail?: CronFailureNotificationDetail;
  cause?: string;
  gone?: CronAutoDisabled["gone"];
  /** The conversation that is gone cannot take the notice; its agent gets it instead. */
  unavailableSessionKey?: string;
};

/** A stop requested through a job update by Gateway code outside the scheduler loop. */
export type CronAutoDisableRequest = CronStopNotice & { reason: "source-unavailable" };

/** `completed` is silent and unrecorded: the job did what it was for. */
type CronStop =
  | { reason: "completed" }
  | (CronStopNotice & {
      reason: CronAutoDisabled["reason"];
      state: CronJobPolicyContext;
      deferredNotifications: DeferredCronNotifications;
    });

/** The notice for a recorded stop: why the job is off and the one reply that resumes it. */
export function buildCronAutoDisableNotice(
  job: Pick<CronJob, "id" | "name" | "state">,
  autoDisabled: CronAutoDisabled,
  facts: CronStopNotice = {},
): string {
  const { reason, consecutiveErrors: count } = autoDisabled;
  const name = truncateUtf16Safe((job.name || job.id).replace(/\s+/g, " ").trim(), 120);
  if (reason === "failed") {
    return [
      `⚠️ Automation "${name}" failed. It was set to run one time, so it will not try again.`,
      ...cronFailureDetailLines(job.state.lastErrorReason, facts.failureNotificationDetail),
      `To try again, reply "run ${name} again".`,
    ].join("\n");
  }
  const why = {
    "consecutive-failures": `It failed ${count} times in a row.`,
    "schedule-errors": `Its schedule could not be worked out ${count} times in a row.`,
    "source-unavailable": facts.cause?.trim() ?? "Something it needs is no longer available.",
  }[reason];
  return [
    `⚠️ Automation "${name}" is turned off. ${why}`,
    ...(reason === "consecutive-failures"
      ? cronFailureDetailLines(job.state.lastErrorReason, facts.failureNotificationDetail)
      : []),
    "It will not run again until it is turned back on.",
    reason === "schedule-errors"
      ? `To resume it, reply "fix the schedule of ${name}".`
      : `To resume it, reply "resume ${name}".`,
  ].join("\n");
}

/** Queues the in-app notice for a recorded stop to the owning agent. */
export function queueCronAutoDisableNotification(
  job: CronJob,
  autoDisabled: CronAutoDisabled,
  deferredNotifications: DeferredCronNotifications,
  facts: CronStopNotice = {},
): void {
  const noticeJob = cronNotificationJob(job);
  const { agentId, sessionKey } = resolveCronNotificationQueueOwner(noticeJob, "auto-disabled");
  deferredNotifications.push({
    kind: "auto-disabled",
    job:
      facts.unavailableSessionKey !== undefined && sessionKey === facts.unavailableSessionKey
        ? { ...noticeJob, owner: undefined, sessionKey: undefined, ...(agentId ? { agentId } : {}) }
        : noticeJob,
    text: buildCronAutoDisableNotice(job, autoDisabled, facts),
  });
}

/** Schedule and source stops notify here; a run-failure stop rides on its run's failure notice. */
export function autoDisableCronJob(job: CronJob, stop: CronStop): boolean {
  // A consumed on-exit watch is already off when its run ends; that stop is still recorded.
  const consumedWatch = job.schedule.kind === "on-exit" && !job.state.autoDisabled;
  if (job.enabled === false && (!consumedWatch || stop.reason === "completed")) {
    return false;
  }
  job.enabled = false;
  job.state.nextRunAtMs = undefined;
  if (stop.reason === "completed") {
    return true;
  }
  const autoDisabled = {
    reason: stop.reason,
    atMs: stop.state.deps.nowMs(),
    consecutiveErrors:
      stop.reason === "schedule-errors"
        ? job.state.scheduleErrorCount || 1
        : (job.state.consecutiveErrors ?? 0),
    ...(stop.reason === "source-unavailable" && stop.gone ? { gone: stop.gone } : {}),
  };
  job.state.autoDisabled = autoDisabled;
  stop.state.deps.log.warn(
    { jobId: job.id, jobName: job.name, ...autoDisabled, error: job.state.lastError },
    "cron: scheduler turned job off",
  );
  if (stop.reason === "schedule-errors" || stop.reason === "source-unavailable") {
    queueCronAutoDisableNotification(job, autoDisabled, stop.deferredNotifications, stop);
  }
  return true;
}
