/** Read-side cron codec between cron history detail and the stable run-history wire shape.
 * Deliberately free of agent/runtime imports so history reads stay dependency-light;
 * the event->entry write codec lives in run-event-codec.ts. */
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import {
  asSafeIntegerInRange,
  MAX_DATE_TIMESTAMP_MS,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readNonBlankString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { FAILOVER_REASONS } from "../../packages/gateway-protocol/src/failover-reasons.js";
import { parseAutomationResult } from "./automation-result.js";
import { resolveCronCompletionStatus } from "./completion-status.js";
import { isCronTimeoutErrorText } from "./execution-error-constants.js";
import { normalizeCronRunDiagnosticsCore } from "./run-diagnostics-normalize.js";
import type { CronJsonValue as JsonValue, CronRunRecord } from "./store/run-history.types.js";

type CronRunLogEntry = import("./run-log-types.js").CronRunLogEntry;
type CronDeliveryStatus = import("./types.js").CronDeliveryStatus;
type CronRunStatus = import("./types.js").CronRunStatus;

const CRON_RUN_DETAIL_KIND = "cron-run";
/** Native JSON parsing keeps released scalar/null and numeric-overflow semantics. */
export function parseCronRunDetailJson(serialized: string): JsonValue | undefined {
  // SAFETY: Native parsing only produces JSON values; undefined denotes a syntax error.
  return safeParseJson(serialized) as JsonValue | undefined;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : parseCronRunDetailJson(serialized);
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return isRecord(value);
}

function normalizeTimestamp(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0, max: MAX_DATE_TIMESTAMP_MS });
}

export function isCronRunStatus(value: unknown): value is CronRunStatus {
  return value === "ok" || value === "error" || value === "skipped";
}

export function isCronDeliveryStatus(value: unknown): value is CronDeliveryStatus {
  return (
    value === "delivered" ||
    value === "not-delivered" ||
    value === "unknown" ||
    value === "not-requested"
  );
}

/** Parses stored or migrated cron history while preserving the stable wire shape. */
export function parseCronRunLogEntryObject(
  obj: unknown,
  opts?: { jobId?: string },
): CronRunLogEntry | null {
  const jobId = normalizeOptionalString(opts?.jobId);
  if (!isRecord(obj) || obj.action !== "finished") {
    return null;
  }
  const entryJobId = readNonBlankString(obj.jobId);
  const ts = normalizeTimestamp(obj.ts);
  if (!entryJobId || ts === undefined || (jobId && entryJobId !== jobId)) {
    return null;
  }
  const status = isCronRunStatus(obj.status) ? obj.status : undefined;
  const delivered = typeof obj.delivered === "boolean" ? obj.delivered : undefined;
  const deliveryStatus = isCronDeliveryStatus(obj.deliveryStatus) ? obj.deliveryStatus : undefined;
  const completionStatus = obj.completionStatus;
  const suppression = obj.deliverySuppressionReason;
  const failure = obj.failureNotificationDelivery;
  const usage = isRecord(obj.usage)
    ? {
        input_tokens: asSafeIntegerInRange(obj.usage.input_tokens, { min: 0 }),
        output_tokens: asSafeIntegerInRange(obj.usage.output_tokens, { min: 0 }),
        total_tokens: asSafeIntegerInRange(obj.usage.total_tokens, { min: 0 }),
        cache_read_tokens: asSafeIntegerInRange(obj.usage.cache_read_tokens, { min: 0 }),
        cache_write_tokens: asSafeIntegerInRange(obj.usage.cache_write_tokens, { min: 0 }),
      }
    : undefined;

  // Keep the released wire projection without schema clones or caught errors for writer-owned nulls.
  return {
    ts,
    jobId: entryJobId,
    action: "finished",
    status,
    completionStatus:
      completionStatus === "succeeded" ||
      completionStatus === "failed" ||
      completionStatus === "unknown"
        ? completionStatus
        : resolveCronCompletionStatus({ status, delivered, deliveryStatus }),
    error: readStringValue(obj.error),
    errorReason: FAILOVER_REASONS.find((reason) => reason === obj.errorReason),
    summary: readStringValue(obj.summary),
    result: parseAutomationResult(obj.result),
    runId: readNonBlankString(obj.runId),
    diagnostics: normalizeCronRunDiagnosticsCore(obj.diagnostics),
    runAtMs: normalizeTimestamp(obj.runAtMs),
    durationMs: asSafeIntegerInRange(obj.durationMs, { min: 0 }),
    nextRunAtMs: normalizeTimestamp(obj.nextRunAtMs),
    triggerFired: typeof obj.triggerFired === "boolean" ? obj.triggerFired : undefined,
    model: readNonBlankString(obj.model),
    provider: readNonBlankString(obj.provider),
    usage: usage && Object.values(usage).some((count) => count !== undefined) ? usage : undefined,
    delivered,
    deliveryStatus,
    deliveryError: readStringValue(obj.deliveryError),
    deliverySuppressionReason:
      suppression === "empty" ||
      suppression === "silent" ||
      suppression === "heartbeat" ||
      suppression === "channel_transform"
        ? suppression
        : undefined,
    failureNotificationDelivery:
      isRecord(failure) && isCronDeliveryStatus(failure.status)
        ? {
            status: failure.status,
            ...(typeof failure.delivered === "boolean" ? { delivered: failure.delivered } : {}),
            ...(typeof failure.error === "string" ? { error: failure.error } : {}),
          }
        : undefined,
    delivery: isJsonObject(obj.delivery) ? obj.delivery : undefined,
    sessionId: readNonBlankString(obj.sessionId),
    sessionKey: readNonBlankString(obj.sessionKey),
  };
}

/** Encodes Cron-owned outcome fields for retained history. */
export function cronRunLogEntryToDetail(
  entry: CronRunLogEntry,
  options: {
    storeKey: string;
    triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown };
    scriptResult?: { scriptStateChanged?: boolean; scriptState?: unknown };
  },
): JsonValue {
  const detail = toJsonValue({
    kind: CRON_RUN_DETAIL_KIND,
    status: entry.status,
    completionStatus: entry.completionStatus,
    error: entry.error ?? null,
    summary: entry.summary ?? null,
    result: entry.result,
    storeKey: options.storeKey,
    errorReason: entry.errorReason,
    diagnostics: entry.diagnostics,
    delivered: entry.delivered,
    deliveryStatus: entry.deliveryStatus,
    deliveryError: entry.deliveryError,
    deliverySuppressionReason: entry.deliverySuppressionReason,
    failureNotificationDelivery: entry.failureNotificationDelivery,
    delivery: entry.delivery,
    sessionId: entry.sessionId,
    // CronRunRecord.runId remains the internal cancellation identity.
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
    scriptStateChanged: options.scriptResult?.scriptStateChanged === true ? true : undefined,
    scriptState:
      options.scriptResult?.scriptStateChanged === true
        ? options.scriptResult.scriptState
        : undefined,
    model: entry.model,
    provider: entry.provider,
    usage: entry.usage,
  });
  return detail ?? { kind: CRON_RUN_DETAIL_KIND };
}

/** Stores quiet-trigger recovery facts without creating a run-history detail row. */
export function cronQuietTriggerDetail(
  storeKey: string,
  triggerEval: { fired: false; stateChanged: boolean; state?: unknown },
): JsonValue {
  return (
    toJsonValue({
      storeKey,
      triggerFired: false,
      triggerStateChanged: triggerEval.stateChanged,
      ...(triggerEval.stateChanged ? { triggerState: triggerEval.state } : {}),
    }) ?? { storeKey, triggerFired: false, triggerStateChanged: false }
  );
}

/** Returns the cron store partition recorded on a cron row. */
export function cronRunRecordStoreKey(record: Pick<CronRunRecord, "detail">): string | undefined {
  return isJsonObject(record.detail) && typeof record.detail.storeKey === "string"
    ? record.detail.storeKey
    : undefined;
}

/** Keeps history projection, recovery, and retention on one record-row timestamp. */
export function resolveCronRunRecordTimestamp(
  record: Pick<CronRunRecord, "endedAt" | "lastEventAt" | "createdAt">,
): number {
  return record.endedAt ?? record.lastEventAt ?? record.createdAt;
}

/** Shared newest-first order for history pages, retention, and recovery. */
export function compareCronRunRecordsNewestFirst(
  left: CronRunRecord,
  right: CronRunRecord,
): number {
  return (
    resolveCronRunRecordTimestamp(right) - resolveCronRunRecordTimestamp(left) ||
    right.createdAt - left.createdAt ||
    right.id.localeCompare(left.id)
  );
}

/** Reads internal trigger recovery data without adding it to run-history responses. */
export function cronRunRecordToTriggerEval(
  record: Pick<CronRunRecord, "detail">,
): { fired: boolean; stateChanged: boolean; state?: JsonValue } | undefined {
  if (!isJsonObject(record.detail) || typeof record.detail.triggerFired !== "boolean") {
    return undefined;
  }
  return {
    fired: record.detail.triggerFired,
    stateChanged: record.detail.triggerStateChanged === true,
    ...(record.detail.triggerStateChanged === true && "triggerState" in record.detail
      ? { state: record.detail.triggerState }
      : {}),
  };
}

/** Reads internal payload-script recovery data without exposing it in run history. */
export function cronRunRecordToScriptRunResult(
  record: Pick<CronRunRecord, "detail">,
): { scriptStateChanged: true; scriptState?: JsonValue } | undefined {
  if (!isJsonObject(record.detail) || record.detail.scriptStateChanged !== true) {
    return undefined;
  }
  return {
    scriptStateChanged: true,
    ...(Object.hasOwn(record.detail, "scriptState")
      ? { scriptState: record.detail.scriptState }
      : {}),
  };
}

/** Preserves the released history row status vocabulary. */
export function cronRunStorageStatus(
  entry: Pick<CronRunLogEntry, "status" | "error"> & Partial<CronRunLogEntry>,
): "succeeded" | "failed" | "timed_out" {
  if (entry.status === "ok") {
    const completionStatus =
      entry.completionStatus ??
      resolveCronCompletionStatus({
        status: entry.status,
        delivered: entry.delivered,
        deliveryStatus: entry.deliveryStatus,
      });
    return completionStatus === "succeeded" ? "succeeded" : "failed";
  }
  return entry.status === "error" && isCronTimeoutErrorText(entry.error) ? "timed_out" : "failed";
}

/** Reconstructs the unchanged CronRunLogEntry wire shape from a cron record row. */
export function cronRunRecordToRunLogEntry(record: CronRunRecord): CronRunLogEntry | null {
  if (!record.jobId || !isJsonObject(record.detail)) {
    return null;
  }
  if (record.detail.kind !== CRON_RUN_DETAIL_KIND) {
    return null;
  }
  // Cron detail is canonical write-time state; history reads do not rederive error reasons.
  return parseCronRunLogEntryObject(
    {
      // Released rows stored these only on the history row; current detail wins
      // when operator cancellation and the underlying execution have different outcomes.
      error: record.error,
      summary: record.summary,
      ...record.detail,
      ts: resolveCronRunRecordTimestamp(record),
      jobId: record.jobId,
      action: "finished",
      sessionKey: record.sessionKey,
      // Public request IDs win; scheduled and on-exit runs still need their receipt-backed ID.
      runId: typeof record.detail.runId === "string" ? record.detail.runId : record.runId,
    },
    { jobId: record.jobId },
  );
}
