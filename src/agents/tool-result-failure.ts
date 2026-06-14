import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const TOOL_RESULT_FAILURE_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "partial_failed",
  "timeout",
  "timed_out",
  "blocked",
  "denied",
  "rejected",
  "not_sent",
  "not-sent",
  "forbidden",
  "unavailable",
  "approval-unavailable",
  "disabled",
  "aborted",
  "cancelled",
  "canceled",
  "killed",
  "invalid",
  "unknown",
  "suppressed",
  "dry_run",
  "cancelled_by_message_sending_hook",
  "cancelled-by-message-sending-hook",
]);

export function isToolResultFailureStatus(value: unknown): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized ? TOOL_RESULT_FAILURE_STATUSES.has(normalized) : false;
}

function hasNestedToolResultDryRunEvidence(value: unknown, depth: number): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.dryRun === true) {
    return true;
  }
  return depth < 3 && hasNestedToolResultDryRunEvidence(record.result, depth + 1);
}

export function hasToolResultDryRunOrFailureEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.dryRun === true ||
    record.ok === false ||
    record.success === false ||
    record.timedOut === true ||
    Boolean(record.error) ||
    (typeof record.exitCode === "number" &&
      Number.isFinite(record.exitCode) &&
      record.exitCode !== 0) ||
    isToolResultFailureStatus(record.status) ||
    isToolResultFailureStatus(record.deliveryStatus ?? record.delivery_status)
  ) {
    return true;
  }
  return hasNestedToolResultDryRunEvidence(record.result, 1);
}
