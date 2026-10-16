import { resolveCronJobConfigRevision } from "./config-revision.js";
import { toPublicCronJob } from "./public-job.js";
import type { CronDeliveryPreview, CronJob } from "./types.js";

// Migration provenance stays internal; the result schema exposes only public scratch fields.
export function cronScratchReadView(
  scratch: { content: string; revision: number; updatedAtMs: number } | undefined,
) {
  if (!scratch) {
    return null;
  }
  return {
    content: scratch.content,
    revision: scratch.revision,
    updatedAtMs: scratch.updatedAtMs,
  };
}

export function cronAddResultReadView(params: {
  result: CronJob | { created: boolean; updated?: boolean; job: CronJob };
  deliveryPreview: CronDeliveryPreview;
}) {
  const job = "job" in params.result ? params.result.job : params.result;
  if ("job" in params.result) {
    return {
      created: params.result.created,
      ...(params.result.updated === undefined ? {} : { updated: params.result.updated }),
      job: cronJobReadView(job),
      deliveryPreview: params.deliveryPreview,
    };
  }
  return {
    ...cronJobReadView(job),
    deliveryPreview: params.deliveryPreview,
  };
}

export function cronJobReadView(job: CronJob) {
  const publicJob = toPublicCronJob(job);
  return {
    ...publicJob,
    configRevision: resolveCronJobConfigRevision(job),
    nextRunAtMs: job.state.nextRunAtMs,
    lastRunAtMs: job.state.lastRunAtMs,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus,
    lastRunError: job.state.lastError,
    lastDelivered: job.state.lastDelivered,
    lastDeliveryStatus: job.state.lastDeliveryStatus,
    lastDeliveryError: job.state.lastDeliveryError,
    deliverySuppressionReason: job.state.deliverySuppressionReason,
    lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered,
    lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus,
    lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError,
  };
}

// Strip only metadata added by the public read view, never unknown definition fields.
// Stored revisions and privacy projection have separate owners and stay unchanged.
export function cronJobDefinitionFromReadView(
  view: Partial<ReturnType<typeof cronJobReadView>> & { effectiveAgentId?: string | null },
) {
  const {
    effectiveAgentId: _effectiveAgentId,
    configRevision: _configRevision,
    nextRunAtMs: _nextRunAtMs,
    lastRunAtMs: _lastRunAtMs,
    lastRunStatus: _lastRunStatus,
    lastRunError: _lastRunError,
    lastDelivered: _lastDelivered,
    lastDeliveryStatus: _lastDeliveryStatus,
    lastDeliveryError: _lastDeliveryError,
    deliverySuppressionReason: _deliverySuppressionReason,
    lastFailureNotificationDelivered: _lastFailureNotificationDelivered,
    lastFailureNotificationDeliveryStatus: _lastFailureNotificationDeliveryStatus,
    lastFailureNotificationDeliveryError: _lastFailureNotificationDeliveryError,
    ...definition
  } = view;
  return definition;
}
