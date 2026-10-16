import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import type { CronCompactJob } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import type { CronServiceContract } from "../../cron/service-contract.js";
import type { CronListPageResult } from "../../cron/service/list-page-types.js";
import type { CronJob } from "../../cron/types.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { registerSerializedJsonArray } from "../serialized-json.js";

type Page = { key: string; jobs: ReturnType<typeof prepareJobs> };
const projections = new WeakMap<CronServiceContract, { compact?: Page; full?: Page }>();

/** Each owner's revision covers the filtered rows; the default agent completes presentation identity. */
export function projectCronListJobs(
  owner: CronServiceContract,
  page: CronListPageResult,
  compact: boolean,
) {
  const defaultAgentId = owner.getDefaultAgentId();
  const key = JSON.stringify([page.snapshotRevision, page.offset, page.limit, defaultAgentId]);
  const mode = compact ? "compact" : "full";
  let cached = projections.get(owner);
  if (!cached) {
    cached = {};
    projections.set(owner, cached);
  }
  if (cached[mode]?.key !== key) {
    cached[mode] = { key, jobs: prepareJobs(page.jobs, defaultAgentId, compact) };
  }
  return cached[mode].jobs;
}

function prepareJobs(jobs: CronJob[], defaultAgentId: string | undefined, compact: boolean) {
  const rows = jobs.map((job) =>
    freezeJsonSnapshot({
      ...(compact ? compactCronListJob(job) : cronJobReadView(job)),
      effectiveAgentId: tryResolveCronJobEffectiveAgentId(job, defaultAgentId) ?? null,
    }),
  );
  return registerSerializedJsonArray(
    Object.freeze(rows),
    rows.map((row) => JSON.stringify(row)),
  );
}

function compactCronListJob(job: CronJob): CronCompactJob {
  const compact: CronCompactJob = {
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    updatedAtMs: job.updatedAtMs,
    declarationKey: job.declarationKey || undefined,
    displayName: job.displayName || undefined,
    owner: job.owner,
    enabled: job.enabled,
    // Keep epoch fields for existing clients; readable dates avoid model timestamp arithmetic.
    nextRunAt: timestampMsToIsoString(job.state.nextRunAtMs) ?? null,
    nextRunAtMs: job.state.nextRunAtMs ?? null,
    scheduleKind: job.schedule.kind,
    // Disabled jobs retain timing without exposing event commands.
    ...(job.schedule.kind === "at" || job.schedule.kind === "every" || job.schedule.kind === "cron"
      ? { schedule: job.schedule }
      : {}),
    trigger: job.trigger ? true : undefined,
    lastRunAt: timestampMsToIsoString(job.state.lastRunAtMs) ?? null,
    lastRunAtMs: job.state.lastRunAtMs ?? null,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus ?? null,
    lastRunError: job.state.lastError ?? null,
    runningAtMs: job.state.runningAtMs,
    autoDisabled: job.state.autoDisabled,
    lastDelivered: job.state.lastDelivered,
    lastDeliveryStatus: job.state.lastDeliveryStatus,
    lastDeliveryError: job.state.lastDeliveryError,
    deliverySuppressionReason: job.state.deliverySuppressionReason,
    lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered,
    lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus,
    lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError,
  };
  // Direct RPC consumers need the same optional-key omission as serialized responses.
  for (const [key, value] of Object.entries(compact)) {
    if (value === undefined) {
      Reflect.deleteProperty(compact, key);
    }
  }
  return compact;
}
