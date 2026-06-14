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

export function hasToolResultDryRunOrFailureEvidence(value: unknown, depth = 0): boolean {
  if (Array.isArray(value)) {
    return (
      depth < 3 && value.some((entry) => hasToolResultDryRunOrFailureEvidence(entry, depth + 1))
    );
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.dryRun === true ||
    record.ok === false ||
    record.success === false ||
    isToolResultFailureStatus(record.status) ||
    isToolResultFailureStatus(record.deliveryStatus ?? record.delivery_status)
  ) {
    return true;
  }
  if (depth >= 3) {
    return false;
  }
  return [record.result, record.results, record.payloadOutcomes].some((entry) =>
    hasToolResultDryRunOrFailureEvidence(entry, depth + 1),
  );
}
