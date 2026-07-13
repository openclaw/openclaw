/** Cron-owned codec between task-ledger detail and the stable run-history wire shape. */
import { resolveFailoverReasonFromError } from "../agents/failover-error.js";
import type { JsonValue, TaskRecord, TaskStatus } from "../tasks/task-registry.types.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import { parseCronRunLogEntryObject } from "./run-log/entry-codec.js";
import { timeoutErrorMessage } from "./service/execution-errors.js";
import type { CronEvent } from "./service/state.js";
import type { CronRunStatus } from "./types.js";

const CRON_TASK_DETAIL_KIND = "cron-run";

type CronFinishedEvent = CronEvent & { action: "finished" };

function toJsonValue(value: unknown): JsonValue | undefined {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : (JSON.parse(serialized) as JsonValue);
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCronRunStatus(value: unknown): value is CronRunStatus {
  return value === "ok" || value === "error" || value === "skipped";
}

/** Uses execution timing for one timestamp shared by ledger and legacy dual-write paths. */
export function resolveCronRunEndedAt(event: CronFinishedEvent, fallbackTs: number): number {
  if (
    typeof event.runAtMs === "number" &&
    Number.isFinite(event.runAtMs) &&
    typeof event.durationMs === "number" &&
    Number.isFinite(event.durationMs)
  ) {
    return event.runAtMs + event.durationMs;
  }
  return fallbackTs;
}

/** Builds the legacy run-history record from one finished service event. */
export function cronRunLogEntryFromEvent(
  event: CronFinishedEvent,
  fallbackTs: number,
): CronRunLogEntry {
  const errorReason = resolveFailoverReasonFromError(event.error, event.provider) ?? undefined;
  return {
    ts: resolveCronRunEndedAt(event, fallbackTs),
    jobId: event.jobId,
    action: "finished",
    status: event.status,
    error: event.error,
    errorReason,
    summary: event.summary,
    diagnostics: event.diagnostics,
    delivered: event.delivered,
    deliveryStatus: event.deliveryStatus,
    deliveryError: event.deliveryError,
    failureNotificationDelivery: event.failureNotificationDelivery,
    delivery: event.delivery,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    runId: event.runId,
    runAtMs: event.runAtMs,
    durationMs: event.durationMs,
    nextRunAtMs: event.nextRunAtMs,
    triggerFired: event.triggerFired,
    model: event.model,
    provider: event.provider,
    usage: event.usage,
  };
}

/** Encodes cron-only outcome fields; generic lifecycle fields stay on TaskRecord. */
export function cronRunLogEntryToTaskDetail(
  entry: CronRunLogEntry,
  options: {
    storeKey: string;
    triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown };
  },
): JsonValue {
  const detail = toJsonValue({
    kind: CRON_TASK_DETAIL_KIND,
    status: entry.status,
    storeKey: options.storeKey,
    errorReason: entry.errorReason,
    diagnostics: entry.diagnostics,
    delivered: entry.delivered,
    deliveryStatus: entry.deliveryStatus,
    deliveryError: entry.deliveryError,
    failureNotificationDelivery: entry.failureNotificationDelivery,
    delivery: entry.delivery,
    sessionId: entry.sessionId,
    // TaskRecord.runId remains the internal cancellation identity.
    runId: entry.runId,
    runAtMs: entry.runAtMs,
    durationMs: entry.durationMs,
    nextRunAtMs: entry.nextRunAtMs,
    triggerFired: entry.triggerFired,
    triggerStateChanged:
      options.triggerEval?.fired === true ? options.triggerEval.stateChanged : undefined,
    triggerState:
      options.triggerEval?.fired === true && options.triggerEval.stateChanged
        ? options.triggerEval.state
        : undefined,
    model: entry.model,
    provider: entry.provider,
    usage: entry.usage,
  });
  return detail ?? { kind: CRON_TASK_DETAIL_KIND };
}

/** Returns the cron store partition recorded on a task row. */
export function cronTaskRecordStoreKey(task: TaskRecord): string | undefined {
  return isJsonObject(task.detail) && typeof task.detail.storeKey === "string"
    ? task.detail.storeKey
    : undefined;
}

/** Reads internal trigger recovery data without adding it to run-history responses. */
export function cronTaskRecordToTriggerEval(
  task: TaskRecord,
): { fired: true; stateChanged: boolean; state?: JsonValue } | undefined {
  if (!isJsonObject(task.detail) || task.detail.triggerFired !== true) {
    return undefined;
  }
  return {
    fired: true,
    stateChanged: task.detail.triggerStateChanged === true,
    ...(task.detail.triggerStateChanged === true && "triggerState" in task.detail
      ? { state: task.detail.triggerState }
      : {}),
  };
}

/** Maps the cron outcome vocabulary onto generic task terminal states. */
export function cronRunStatusToTaskStatus(
  entry: CronRunLogEntry,
): Extract<TaskStatus, "succeeded" | "failed" | "timed_out"> {
  if (entry.status === "ok" || entry.status === "skipped") {
    return "succeeded";
  }
  return entry.error === timeoutErrorMessage() ? "timed_out" : "failed";
}

/** Reconstructs the unchanged CronRunLogEntry wire shape from a cron task row. */
export function cronTaskRecordToRunLogEntry(task: TaskRecord): CronRunLogEntry | null {
  if (task.runtime !== "cron" || !task.sourceId || !isJsonObject(task.detail)) {
    return null;
  }
  if (task.detail.kind !== CRON_TASK_DETAIL_KIND || !isCronRunStatus(task.detail.status)) {
    return null;
  }
  const wireDetail = { ...task.detail };
  delete wireDetail.storeKey;
  const entry = parseCronRunLogEntryObject(
    {
      ...wireDetail,
      ts: task.endedAt ?? task.lastEventAt ?? task.createdAt,
      jobId: task.sourceId,
      action: "finished",
      status: task.detail.status,
      error: task.error,
      summary: task.terminalSummary,
      sessionKey: task.childSessionKey,
      runId: typeof task.detail.runId === "string" ? task.detail.runId : undefined,
    },
    { jobId: task.sourceId },
  );
  if (!entry) {
    return null;
  }
  // The legacy SQLite reader materializes these indexed columns even when absent.
  return {
    ...entry,
    delivered: entry.delivered,
    deliveryStatus: entry.deliveryStatus,
    deliveryError: entry.deliveryError,
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
  };
}
