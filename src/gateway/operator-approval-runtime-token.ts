import { randomBytes, timingSafeEqual } from "node:crypto";

let approvalRuntimeToken: string | null = null;

/**
 * Return the process-local token used to trust internal operator approval
 * callbacks. The token is intentionally not persisted; process restart
 * invalidates outstanding in-memory callback links.
 */
export function getOperatorApprovalRuntimeToken(): string {
  approvalRuntimeToken ??= randomBytes(32).toString("base64url");
  return approvalRuntimeToken;
}

/**
 * Compare a presented operator approval runtime token against the process-local
 * token with timing-safe equality once lengths match.
 */
export function isOperatorApprovalRuntimeToken(value: string | null | undefined): boolean {
  const token = value?.trim();
  if (!token) {
    return false;
  }
  const expected = getOperatorApprovalRuntimeToken();
  const tokenBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return tokenBytes.length === expectedBytes.length && timingSafeEqual(tokenBytes, expectedBytes);
}
