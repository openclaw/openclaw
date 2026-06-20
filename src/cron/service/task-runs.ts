/** Detached task-ledger integration for cron runs. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import { acquireTaskRouteLease, settleTaskRouteLease } from "../../tasks/task-route-lease.js";
import { resolveCronAgentSessionKey } from "../isolated-agent/session-key.js";
import { createCronExecutionId } from "../run-id.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { normalizeCronRunErrorText, timeoutErrorMessage } from "./execution-errors.js";
import type { CronServiceState } from "./state.js";
import { CRON_TASK_RUNNING_PROGRESS_SUMMARY } from "./task-ledger.js";

/** Converts cron ids into bounded session-key path segments with a fallback for empty input. */
export function normalizeCronLaneSegment(value: string | undefined, fallback: string): string {
  const normalized = normalizeOptionalLowercaseString(value)
    ?.replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

/** Builds the main-session child key used to isolate one cron run's task transcript. */
export function resolveMainSessionCronRunSessionKey(job: CronJob, startedAt: number): string {
  const explicitAgentId = job.agentId?.trim();
  const agentId = normalizeAgentId(explicitAgentId || resolveAgentIdFromSessionKey(job.sessionKey));
  const jobSegment = normalizeCronLaneSegment(job.id, "job");
  const runSegment = normalizeCronLaneSegment(String(Math.max(0, Math.floor(startedAt))), "run");
  return `agent:${agentId}:cron:${jobSegment}:run:${runSegment}`;
}

function resolveCronTaskChildSessionKey(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
}): string | undefined {
  if (params.job.sessionTarget === "main") {
    return resolveMainSessionCronRunSessionKey(params.job, params.startedAt);
  }
  const explicitSessionKey = params.job.sessionKey?.trim();
  if (explicitSessionKey) {
    // Explicit session bindings must win over generated cron session keys so
    // task drill-down opens the same transcript the cron run actually used.
    return explicitSessionKey;
  }
  if (params.job.sessionTarget !== "isolated") {
    return undefined;
  }
  return resolveCronAgentSessionKey({
    sessionKey: `cron:${params.job.id}`,
    agentId: params.job.agentId ?? params.state.deps.defaultAgentId ?? DEFAULT_AGENT_ID,
  });
}

/** Creates a best-effort detached task ledger row for a cron run. */
export function tryCreateCronTaskRun(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
}): string | undefined {
  const runId = createCronExecutionId(params.job.id, params.startedAt);
  try {
    const task = createRunningTaskRun({
      runtime: "cron",
      sourceId: params.job.id,
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: resolveCronTaskChildSessionKey(params),
      agentId: params.job.agentId,
      runId,
      label: params.job.name,
      task: params.job.name || params.job.id,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: params.startedAt,
      lastEventAt: params.startedAt,
      progressSummary: CRON_TASK_RUNNING_PROGRESS_SUMMARY,
    });
    if (!task) {
      params.state.deps.log.warn(
        { jobId: params.job.id },
        "cron: task ledger record was not persisted",
      );
      return undefined;
    }
    // #92460: acquire a task-route lease keyed by the detached run id so
    // the delivery-target resolver can recover the original outbound
    // origin later, even if the originating session entry has been
    // evicted or the shared main session bucket was retargeted by
    // another conversation before completion fires. The auto-hook in
    // createRunningTaskRun skips acquire when deliveryStatus is
    // 'not_applicable' (the task itself is not the delivery owner), so
    // we acquire it explicitly here using the cron job's own delivery
    // config as the captured origin. Best-effort: never throws.
    acquireTaskRouteLease({
      runId,
      taskId: task.taskId,
      requesterOrigin: resolveCronLeaseRequesterOrigin(params.job),
    });
    return runId;
  } catch (error) {
    params.state.deps.log.warn(
      { jobId: params.job.id, error },
      "cron: failed to create task ledger record",
    );
    return undefined;
  }
}

/** Completes or fails the detached task ledger row for a cron run when one exists. */
export function tryFinishCronTaskRun(
  state: CronServiceState,
  result: {
    taskRunId?: string;
    status: CronRunStatus;
    error?: unknown;
    endedAt: number;
    summary?: string;
  },
): void {
  if (!result.taskRunId) {
    return;
  }
  try {
    if (result.status === "ok" || result.status === "skipped") {
      completeTaskRunByRunId({
        runId: result.taskRunId,
        runtime: "cron",
        endedAt: result.endedAt,
        lastEventAt: result.endedAt,
        terminalSummary: result.summary ?? undefined,
      });
      // #92460: settle the task-route lease on terminal run status. The
      // task ledger finalize path (completeTaskRunByRunId) does not call
      // setDetachedTaskDeliveryStatusByRunId, so the auto-settle hook
      // there does not fire. We settle explicitly here so the lease
      // can be GC'd instead of waiting for TTL expiry. Idempotent.
      settleTaskRouteLease(result.taskRunId, "settled");
      return;
    }
    failTaskRunByRunId({
      runId: result.taskRunId,
      runtime: "cron",
      status:
        normalizeCronRunErrorText(result.error) === timeoutErrorMessage() ? "timed_out" : "failed",
      endedAt: result.endedAt,
      lastEventAt: result.endedAt,
      error: result.status === "error" ? normalizeCronRunErrorText(result.error) : undefined,
      terminalSummary: result.summary ?? undefined,
    });
    // Failed cron runs retire the lease (the run did not successfully
    // land delivery on the captured origin). Idempotent.
    settleTaskRouteLease(result.taskRunId, "retired");
  } catch (error) {
    state.deps.log.warn(
      { runId: result.taskRunId, jobStatus: result.status, error },
      "cron: failed to update task ledger record",
    );
  }
}

/**
 * #92460: build a `DeliveryContext` from a cron job's own delivery config.
 * Used as the `requesterOrigin` for the task-route lease acquired at
 * cron run start. When the originating session entry is gone or the
 * shared main session bucket was retargeted by another conversation
 * before completion fires, the delivery-target resolver falls back to
 * this captured origin (see `delivery-target.ts`).
 *
 * Returns `undefined` when the job has no usable delivery config
 * (e.g. mode === "none" or mode === "webhook" with no chat target).
 * The lease is still acquired in that case so the row exists; the
 * origin will be empty and the resolver will fall through to the
 * standard session-key lookup chain.
 *
 * Exported so `ops.ts` `tryCreateManualTaskRun` can apply the same
 * origin derivation to manual cron runs (manual runs were the
 * reported #92460 path — see ClawSweeper review on PR #95012).
 */
export function resolveCronLeaseRequesterOrigin(job: CronJob) {
  const delivery = job.delivery;
  if (!delivery) {
    return undefined;
  }
  // mode "none" / "webhook" with no chat target → no usable origin.
  if (delivery.mode === "none") {
    return undefined;
  }
  if (delivery.mode === "webhook" && !delivery.channel && !delivery.to) {
    return undefined;
  }
  const origin: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  } = {};
  if (delivery.channel) {
    origin.channel = delivery.channel;
  }
  if (delivery.to) {
    origin.to = delivery.to;
  }
  if (delivery.accountId) {
    origin.accountId = delivery.accountId;
  }
  if (delivery.threadId !== undefined && delivery.threadId !== null) {
    origin.threadId = delivery.threadId;
  }
  return Object.keys(origin).length > 0 ? origin : undefined;
}
