import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { toPublicCronJob } from "./public-job.js";
import { cronJobNeedsCreatorReauthorization } from "./tools-allow.js";
import type { CronDeliveryPreview, CronJob, CronStoredJob } from "./types.js";

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

/** Project saved settings for readers without exposing the scheduler's authorization records. */
export function cronJobReadView(job: CronStoredJob) {
  const publicJob = toPublicCronJob(job);
  return {
    ...publicJob,
    billingProfileId:
      job.payload.kind === "agentTurn" &&
      !job.pluginCommand &&
      !job.runtimeAuthority &&
      !job.ownerTransferPending
        ? (job.inferenceBinding?.profileId ??
          splitTrailingAuthProfile(job.payload.model ?? "").profile ??
          null)
        : undefined,
    configRevision: resolveCronJobConfigRevision(job),
    reauthorizationRequired: cronJobNeedsCreatorReauthorization({ job }),
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
    reauthorizationRequired: _reauthorizationRequired,
    billingProfileId: _billingProfileId,
    streamExecutionHost: _streamExecutionHost,
    payloadSource: _payloadSource,
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
