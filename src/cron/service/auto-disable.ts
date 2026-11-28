/** Shared state and owner notification for a cron job that cannot run again as written. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CronJob } from "../types.js";
import { cronNotificationJob } from "./notification-intents.js";
import type { DeferredCronNotifications } from "./state.js";

/**
 * Records one canonical auto-disable fact and queues its owning-agent notification.
 * `schedule-errors`: the schedule cannot produce a next run. `account-unavailable`: the job's
 * recorded account was removed, signed out or replaced, and nothing else could run it.
 */
export function autoDisableCronJob(params: {
  job: CronJob;
  atMs: number;
  consecutiveErrors: number;
  deferredNotifications: DeferredCronNotifications;
  reason?: "schedule-errors" | "account-unavailable";
  /** Provider sign-in command for `account-unavailable`, when the provider is known. */
  signInCommand?: string;
  /**
   * Enablement the run was admitted with. A run outcome can disable a finished one-shot before
   * this records why; an operator's own disable still leaves the job untouched.
   */
  enabledAtAdmission?: boolean;
}): void {
  const { job } = params;
  if (!(params.enabledAtAdmission ?? job.enabled) || job.state.autoDisabled) {
    return;
  }
  const reason = params.reason ?? "schedule-errors";
  job.enabled = false;
  job.state.nextRunAtMs = undefined;
  job.state.autoDisabled = {
    reason,
    atMs: params.atMs,
    consecutiveErrors: params.consecutiveErrors,
  };
  const name = truncateUtf16Safe((job.name || job.id).replace(/\s+/g, " ").trim(), 120);
  params.deferredNotifications.push({
    kind: "auto-disabled",
    job: cronNotificationJob(job),
    // The refusal in automation history names the account; the notice names only the repair.
    text: (reason === "account-unavailable"
      ? [
          `⚠️ Automation "${name}" was auto-disabled: the account it runs on was removed, signed out or replaced since the automation recorded it.`,
          `Sign in again if needed${params.signInCommand ? ` (\`${params.signInCommand}\`)` : ""}, then record the account with \`openclaw automations edit ${job.id} --model <provider/model>@<profileId>\` (list accounts: \`openclaw gateway call models.authStatus\`). To use a key in the environment or provider config instead: \`openclaw automations edit ${job.id} --model <provider/model>\`.`,
          `Then run \`openclaw automations enable ${job.id}\` to re-enable it.`,
        ]
      : [
          `⚠️ Automation "${name}" was auto-disabled after ${params.consecutiveErrors} consecutive schedule errors.`,
          "Check automation history for details.",
          `Fix the underlying cause, then run \`openclaw automations enable ${job.id}\` to re-enable it.`,
        ]
    ).join("\n"),
  });
}
