import { randomBytes } from "node:crypto";
import { safeEqualSecret } from "../security/secret-equal.js";

let approvalRuntimeToken: string | null = null;

export function getOperatorApprovalRuntimeToken(): string {
  approvalRuntimeToken ??= randomBytes(32).toString("base64url");
  return approvalRuntimeToken;
}

export function isOperatorApprovalRuntimeToken(value: string | null | undefined): boolean {
  const token = value?.trim();
  if (!token) {
    return false;
  }
  const expected = getOperatorApprovalRuntimeToken();
  return safeEqualSecret(token, expected);
}
