// Detects approval-not-found errors across gateway response shapes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const INVALID_REQUEST = "INVALID_REQUEST";
const APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND";
const APPROVAL_EXPIRED = "APPROVAL_EXPIRED";
const APPROVAL_ALREADY_RESOLVED = "APPROVAL_ALREADY_RESOLVED";

function readErrorCode(value: unknown): string | null {
  return typeof value === "string" ? (normalizeOptionalString(value) ?? null) : null;
}

function readApprovalNotFoundDetailsReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" ? (normalizeOptionalString(reason) ?? null) : null;
}

/**
 * Detects approval-not-found failures across gateway error shapes.
 * Kept broad enough for legacy message-only errors emitted before structured codes.
 */
export function isApprovalNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  if (gatewayCode === APPROVAL_NOT_FOUND) {
    return true;
  }
  const detailsReason = readApprovalNotFoundDetailsReason((err as { details?: unknown }).details);
  if (gatewayCode === INVALID_REQUEST && detailsReason === APPROVAL_NOT_FOUND) {
    return true;
  }
  return /unknown or expired approval id/i.test(err.message);
}

/**
 * Detects that an approval failed because its window elapsed before a decision
 * was submitted (distinct from a genuinely unknown id). The operator should
 * re-run the command to request a fresh approval.
 */
export function isApprovalExpiredError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  if (gatewayCode === APPROVAL_EXPIRED) {
    return true;
  }
  const detailsReason = readApprovalNotFoundDetailsReason((err as { details?: unknown }).details);
  if (detailsReason === APPROVAL_EXPIRED) {
    return true;
  }
  return /approval expired/i.test(err.message);
}

/**
 * Detects that an approval was already decided. A duplicate submit of the same
 * decision succeeds silently during the resolved grace window; this fires for
 * the conflicting or post-grace duplicate that the gateway rejects.
 */
export function isApprovalAlreadyResolvedError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  if (gatewayCode === APPROVAL_ALREADY_RESOLVED) {
    return true;
  }
  const detailsReason = readApprovalNotFoundDetailsReason((err as { details?: unknown }).details);
  if (detailsReason === APPROVAL_ALREADY_RESOLVED) {
    return true;
  }
  return /approval already resolved/i.test(err.message);
}
