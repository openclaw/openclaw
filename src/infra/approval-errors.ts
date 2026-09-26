// Detects approval-not-found errors across gateway response shapes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const INVALID_REQUEST = "INVALID_REQUEST";
const APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND";
const APPROVAL_ALREADY_RESOLVED = "APPROVAL_ALREADY_RESOLVED";
const FORBIDDEN = "FORBIDDEN";
const APPROVAL_AUTHORITY_REQUIRED = "APPROVAL_AUTHORITY_REQUIRED";
const LEGACY_APPROVAL_NOT_FOUND_RE =
  /\b(?:unknown or expired approval id|approval expired or not found)\b/i;

function readErrorCode(value: unknown): string | null {
  return typeof value === "string" ? (normalizeOptionalString(value) ?? null) : null;
}

/** Reads a gateway error code off a thrown error without asserting its shape. */
function gatewayCodeOf(err: Error): string | null {
  return readErrorCode(Reflect.get(err, "gatewayCode"));
}

function readApprovalErrorDetail(value: unknown, key: "code" | "reason"): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return readErrorCode(Reflect.get(value, key));
}

/**
 * Whether a resolve failure means "not this approval kind" while walking exec then plugin.
 * A channel that authorizes one kind and not the other answers the wrong kind with a refusal,
 * so treating only not-found as the signal would end the search at the first kind.
 */
export function isApprovalKindMismatchError(err: unknown): boolean {
  return isApprovalNotFoundError(err) || isApprovalAuthorityError(err);
}

/**
 * Detects a decision the channel would not let this reviewer make. Distinct from not-found:
 * it answers who may decide, not whether the approval exists or is still open, so a control
 * that carried it has no reason to be retired.
 */
export function isApprovalAuthorityError(err: unknown): boolean {
  if (!(err instanceof Error) || gatewayCodeOf(err) !== FORBIDDEN) {
    return false;
  }
  return (
    readApprovalErrorDetail(Reflect.get(err, "details"), "code") === APPROVAL_AUTHORITY_REQUIRED
  );
}

/**
 * Tries each approval kind in order until one resolves. A kind that is not this approval answers
 * not-found and a kind the channel does not let this reviewer decide answers with a refusal;
 * either moves on to the next kind, and any other failure ends the walk. When every kind answers
 * one of those two, the refusal is rethrown over not-found: not-found would tell a refused
 * reviewer that the approval is gone.
 */
export async function resolveFirstApprovalKind<TKind, TResult>(
  kinds: readonly TKind[],
  resolve: (kind: TKind) => Promise<TResult>,
): Promise<TResult> {
  let refusal: unknown;
  let lastError: unknown = new Error("no approval kind to resolve");
  for (const kind of kinds) {
    try {
      return await resolve(kind);
    } catch (error) {
      if (!isApprovalKindMismatchError(error)) {
        throw error;
      }
      if (isApprovalAuthorityError(error)) {
        refusal ??= error;
      }
      lastError = error;
    }
  }
  throw refusal ?? lastError;
}

/** What an operator can do about a decision their channel would not let them make. */
// A refusal says nothing about whether the request is still waiting — only who can decide it.
export const APPROVAL_AUTHORITY_REQUIRED_TEXT =
  "That decision needs an approver listed for this channel. Ask a listed approver to decide it.";

/**
 * Detects approval-not-found failures across gateway error shapes.
 * Kept broad enough for legacy message-only errors emitted before structured codes.
 */
export function isApprovalNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = gatewayCodeOf(err);
  if (gatewayCode === APPROVAL_NOT_FOUND) {
    return true;
  }
  const detailsReason = readApprovalErrorDetail(Reflect.get(err, "details"), "reason");
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
  const gatewayCode = gatewayCodeOf(err);
  const detailsReason = readApprovalErrorDetail(Reflect.get(err, "details"), "reason");
  return (
    (gatewayCode === INVALID_REQUEST && detailsReason === APPROVAL_ALREADY_RESOLVED) ||
    /approval already resolved/i.test(err.message)
  );
}
