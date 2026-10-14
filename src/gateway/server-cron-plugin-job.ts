import type { CronJob } from "../cron/types.js";
import type { PluginHookGatewayCronJob } from "../plugins/hook-gateway.types.js";

/** Map internal CronJob to the public plugin SDK shape. */
export function toPluginCronJob(job: CronJob): PluginHookGatewayCronJob {
  return {
    id: job.id,
    agentId: job.agentId,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    schedule: job.schedule ? structuredClone(job.schedule) : undefined,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload ? structuredClone(job.payload) : undefined,
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
