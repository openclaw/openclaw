// Detects approval-not-found errors across gateway response shapes.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const INVALID_REQUEST = "INVALID_REQUEST";
const APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND";
const APPROVAL_ALREADY_RESOLVED = "APPROVAL_ALREADY_RESOLVED";
const LEGACY_APPROVAL_NOT_FOUND_RE =
  /\b(?:unknown or expired approval id|approval expired or not found)\b/i;

function readApprovalErrorDetailsReason(value: unknown): string | null {
  return normalizeOptionalString(asOptionalRecord(value)?.reason) ?? null;
}

/**
 * Detects approval-not-found failures across gateway error shapes.
 * Kept broad enough for legacy message-only errors emitted before structured codes.
 */
export function isApprovalNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = normalizeOptionalString((err as { gatewayCode?: unknown }).gatewayCode);
  if (gatewayCode === APPROVAL_NOT_FOUND) {
    return true;
  }
  const detailsReason = readApprovalErrorDetailsReason((err as { details?: unknown }).details);
  if (gatewayCode === INVALID_REQUEST && detailsReason === APPROVAL_NOT_FOUND) {
    return true;
  }
  return LEGACY_APPROVAL_NOT_FOUND_RE.test(err.message);
}

/** Detects approval failures that mean a pending prompt is no longer actionable. */
export function isApprovalStaleError(err: unknown): boolean {
  if (isApprovalNotFoundError(err)) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = normalizeOptionalString((err as { gatewayCode?: unknown }).gatewayCode);
  const detailsReason = readApprovalErrorDetailsReason((err as { details?: unknown }).details);
  return (
    (gatewayCode === INVALID_REQUEST && detailsReason === APPROVAL_ALREADY_RESOLVED) ||
    /approval already resolved/i.test(err.message)
  );
}
