import { randomBytes, timingSafeEqual } from "node:crypto";

let approvalRuntimeToken: string | null = null;

/** Returns the process-local token used by trusted local approval runtimes. */
export function getOperatorApprovalRuntimeToken(): string {
  approvalRuntimeToken ??= randomBytes(32).toString("base64url");
  return approvalRuntimeToken;
}

/** Validates a presented approval runtime token without leaking token bytes via timing. */
export function isOperatorApprovalRuntimeToken(value: string | null | undefined): boolean {
  const token = value?.trim();
  if (!token) {
    return false;
  }
  const expected = getOperatorApprovalRuntimeToken();
  const tokenBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  // timingSafeEqual requires equal-length buffers; keep the length check outside
  // the comparison so invalid tokens fail without throwing.
  return tokenBytes.length === expectedBytes.length && timingSafeEqual(tokenBytes, expectedBytes);
}
