import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import type { CronCompactJob } from "../../../packages/gateway-protocol/src/index.js";
import type { CronJob } from "../../cron/types.js";

export function compactCronListJob(job: CronJob): CronCompactJob {
  // Optional declaration/delivery fields are omitted when unset so compact
  // rows stay lean for the common undeclared job.
  return {
    id: job.id,
    name: job.name,
    ...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
    updatedAtMs: job.updatedAtMs,
    ...(job.declarationKey ? { declarationKey: job.declarationKey } : {}),
    ...(job.displayName ? { displayName: job.displayName } : {}),
    ...(job.owner ? { owner: job.owner } : {}),
    enabled: job.enabled,
    // Keep epoch fields for existing clients; readable dates avoid model timestamp arithmetic.
    nextRunAt: timestampMsToIsoString(job.state.nextRunAtMs) ?? null,
    nextRunAtMs: job.state.nextRunAtMs ?? null,
    scheduleKind: job.schedule.kind,
    // Disabled jobs have no next run. Keep their timing without exposing event commands.
    ...(job.schedule.kind === "at" || job.schedule.kind === "every" || job.schedule.kind === "cron"
      ? { schedule: job.schedule }
      : {}),
    ...(job.trigger ? { trigger: true } : {}),
    lastRunAt: timestampMsToIsoString(job.state.lastRunAtMs) ?? null,
    lastRunAtMs: job.state.lastRunAtMs ?? null,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus ?? null,
    lastRunError: job.state.lastError ?? null,
    ...(job.state.runningAtMs !== undefined ? { runningAtMs: job.state.runningAtMs } : {}),
    ...(job.state.autoDisabled !== undefined ? { autoDisabled: job.state.autoDisabled } : {}),
    ...(job.state.lastDelivered !== undefined ? { lastDelivered: job.state.lastDelivered } : {}),
    ...(job.state.lastDeliveryStatus !== undefined
      ? { lastDeliveryStatus: job.state.lastDeliveryStatus }
      : {}),
    ...(job.state.lastDeliveryError !== undefined
      ? { lastDeliveryError: job.state.lastDeliveryError }
      : {}),
    ...(job.state.deliverySuppressionReason !== undefined
      ? { deliverySuppressionReason: job.state.deliverySuppressionReason }
      : {}),
    ...(job.state.lastFailureNotificationDelivered !== undefined
      ? { lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered }
      : {}),
    ...(job.state.lastFailureNotificationDeliveryStatus !== undefined
      ? { lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus }
      : {}),
    ...(job.state.lastFailureNotificationDeliveryError !== undefined
      ? { lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError }
      : {}),
  };
}
