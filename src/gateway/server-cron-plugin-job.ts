import { redactCronCommandSummaryForExternalDelivery } from "../cron/command-output-summary.js";
import type { CronEvent } from "../cron/service.js";
import type { CronJob } from "../cron/types.js";
import type {
  PluginHookCronChangedEvent,
  PluginHookGatewayCronJob,
} from "../plugins/hook-gateway.types.js";
import { pickDefined } from "./server-cron-completion.js";

/** Map internal CronJob to the public plugin SDK shape. */
function toPluginCronJob(job: CronJob): PluginHookGatewayCronJob {
  return {
    id: job.id,
    agentId: job.agentId,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    schedule: structuredClone(job.schedule),
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: structuredClone(job.payload),
    state: {
      nextRunAtMs: job.state.nextRunAtMs,
      runningAtMs: job.state.runningAtMs,
      lastRunAtMs: job.state.lastRunAtMs,
      lastRunStatus: job.state.lastRunStatus,
      lastError: job.state.lastError,
      lastDurationMs: job.state.lastDurationMs,
      lastDelivered: job.state.lastDelivered,
      lastDeliveryStatus: job.state.lastDeliveryStatus,
      lastDeliveryError: job.state.lastDeliveryError,
      deliverySuppressionReason: job.state.deliverySuppressionReason,
      lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered,
      lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus,
      lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError,
      streamStatus: job.state.streamStatus,
      streamError: job.state.streamError,
      streamConsecutiveFailures: job.state.streamConsecutiveFailures,
      streamRestartExhausted: job.state.streamRestartExhausted,
      streamDroppedBatches: job.state.streamDroppedBatches,
      streamCoalescedBatches: job.state.streamCoalescedBatches,
      streamLastStartedAtMs: job.state.streamLastStartedAtMs,
      streamLastExitAtMs: job.state.streamLastExitAtMs,
    },
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
  };
}

/** Omit internal delivery and usage detail; redact command output before plugin delivery. */
export function toPluginCronChangedEvent(
  evt: CronEvent,
  jobSnapshot: CronJob | undefined,
): PluginHookCronChangedEvent {
  const pluginJob = jobSnapshot ? toPluginCronJob(jobSnapshot) : undefined;
  const hookSummary =
    jobSnapshot?.payload?.kind === "command" && typeof evt.summary === "string"
      ? redactCronCommandSummaryForExternalDelivery(evt.summary)
      : evt.summary;
  return {
    action: evt.action,
    jobId: evt.jobId,
    ...(pluginJob ? { job: pluginJob } : {}),
    // Top-level routing fields so plugins don't have to dig into job.
    sessionTarget: jobSnapshot?.sessionTarget,
    agentId: jobSnapshot?.agentId,
    ...pickDefined(evt, [
      "runAtMs",
      "durationMs",
      "status",
      "completionStatus",
      "error",
      "delivered",
      "deliveryStatus",
      "deliveryError",
      "deliverySuppressionReason",
      "sessionId",
      "sessionKey",
      "runId",
      "nextRunAtMs",
      "model",
      "provider",
    ]),
    ...(hookSummary !== undefined ? { summary: hookSummary } : {}),
  };
}
