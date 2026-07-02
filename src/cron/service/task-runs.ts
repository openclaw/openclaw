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

type CronTaskRunWarn = (meta: Record<string, unknown>, message: string) => void;

/**
 * Best-effort detached ledger row for one cron-shaped agent run.
 *
 * Shared by scheduled cron jobs and gateway hook dispatches. The registry's
 * cron-runtime contract requires `sourceId` to be a job id currently marked
 * via `markCronJobActive`; rows without an active marker are swept to "lost"
 * by task maintenance after the reconcile grace.
 */
export function tryCreateCronRunLedgerRow(params: {
  warn: CronTaskRunWarn;
  job: CronJob;
  runId: string;
  childSessionKey: string | undefined;
  label: string;
  progressSummary: string;
  startedAt: number;
}): string | undefined {
  try {
    const task = createRunningTaskRun({
      runtime: "cron",
      sourceId: params.job.id,
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: params.childSessionKey,
      agentId: params.job.agentId,
      runId: params.runId,
      label: params.label,
      task: params.job.name || params.job.id,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: params.startedAt,
      lastEventAt: params.startedAt,
      progressSummary: params.progressSummary,
    });
    if (!task) {
      params.warn({ jobId: params.job.id }, "cron: task ledger record was not persisted");
      return undefined;
    }
    return params.runId;
  } catch (error) {
    params.warn({ jobId: params.job.id, error }, "cron: failed to create task ledger record");
    return undefined;
  }
}

/** Completes or fails a cron-shaped detached ledger row when one exists. */
export function tryFinishCronRunLedgerRow(params: {
  warn: CronTaskRunWarn;
  taskRunId: string | undefined;
  status: CronRunStatus;
  failStatus?: "failed" | "timed_out" | "cancelled";
  error?: string;
  summary?: string;
  endedAt: number;
}): void {
  if (!params.taskRunId) {
    return;
  }
  try {
    if (params.status === "ok" || params.status === "skipped") {
      completeTaskRunByRunId({
        runId: params.taskRunId,
        runtime: "cron",
        endedAt: params.endedAt,
        lastEventAt: params.endedAt,
        terminalSummary: params.summary ?? undefined,
      });
      return;
    }
    failTaskRunByRunId({
      runId: params.taskRunId,
      runtime: "cron",
      status: params.failStatus ?? "failed",
      endedAt: params.endedAt,
      lastEventAt: params.endedAt,
      error: params.error,
      terminalSummary: params.summary ?? undefined,
    });
  } catch (error) {
    params.warn(
      { runId: params.taskRunId, jobStatus: params.status, error },
      "cron: failed to update task ledger record",
    );
  }
}

/** Creates a best-effort detached task ledger row for a cron run. */
export function tryCreateCronTaskRun(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
}): string | undefined {
  return tryCreateCronRunLedgerRow({
    warn: (meta, message) => params.state.deps.log.warn(meta, message),
    job: params.job,
    runId: createCronExecutionId(params.job.id, params.startedAt),
    childSessionKey: resolveCronTaskChildSessionKey(params),
    label: params.job.name,
    progressSummary: CRON_TASK_RUNNING_PROGRESS_SUMMARY,
    startedAt: params.startedAt,
  });
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
  const errorText = result.status === "error" ? normalizeCronRunErrorText(result.error) : undefined;
  tryFinishCronRunLedgerRow({
    warn: (meta, message) => state.deps.log.warn(meta, message),
    taskRunId: result.taskRunId,
    status: result.status,
    failStatus:
      normalizeCronRunErrorText(result.error) === timeoutErrorMessage() ? "timed_out" : "failed",
    error: errorText,
    summary: result.summary,
    endedAt: result.endedAt,
  });
}
