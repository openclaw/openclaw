/** Shared state and owner notification for a cron job whose schedule cannot produce a next run. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CronJob } from "../types.js";
import { cronNotificationJob } from "./notification-intents.js";
import type { DeferredCronNotifications } from "./state.js";

/** Records one canonical auto-disable fact and queues its owning-agent notification. */
export function autoDisableCronJob(params: {
  job: CronJob;
  atMs: number;
  consecutiveErrors: number;
  deferredNotifications: DeferredCronNotifications;
}): void {
  const { job } = params;
  if (!job.enabled || job.state.autoDisabled) {
    return;
  }
  job.enabled = false;
  job.state.nextRunAtMs = undefined;
  job.state.autoDisabled = {
    reason: "schedule-errors",
    atMs: params.atMs,
    consecutiveErrors: params.consecutiveErrors,
  };
  const name = truncateUtf16Safe((job.name || job.id).replace(/\s+/g, " ").trim(), 120);
  params.deferredNotifications.push({
    kind: "auto-disabled",
    job: cronNotificationJob(job),
    text: [
      `⚠️ Automation "${name}" was auto-disabled after ${params.consecutiveErrors} consecutive schedule errors.`,
      "Check automation history for details.",
      `Fix the underlying cause, then run \`openclaw automations enable ${job.id}\` to re-enable it.`,
    ].join("\n"),
  });
}
