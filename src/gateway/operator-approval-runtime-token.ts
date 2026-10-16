// Operator approval runtime token.
// Uses an existing shared socket token when available, with a process-local fallback.
import { createHmac, randomBytes } from "node:crypto";
import { loadExecApprovalsReadOnlyAsync } from "../infra/exec-approvals-store.js";
import { safeEqualSecret } from "../security/secret-equal.js";

const APPROVAL_RUNTIME_TOKEN_CONTEXT = "openclaw:gateway-approval-runtime-token:v1";

let fallbackApprovalRuntimeToken: string | null = null;

function deriveApprovalRuntimeToken(socketToken: string): string {
  return createHmac("sha256", socketToken)
    .update(APPROVAL_RUNTIME_TOKEN_CONTEXT)
    .digest("base64url");
}

async function readSharedApprovalRuntimeToken(): Promise<string | null> {
  const token = (await loadExecApprovalsReadOnlyAsync()).socket?.token?.trim();
  return token ? deriveApprovalRuntimeToken(token) : null;
}

function getFallbackApprovalRuntimeToken(): string {
  fallbackApprovalRuntimeToken ??= randomBytes(32).toString("base64url");
  return fallbackApprovalRuntimeToken;
}

/**
 * Returns the token used to authorize local operator-approval clients.
 */
export async function getOperatorApprovalRuntimeToken(): Promise<string> {
  const sharedToken = await readSharedApprovalRuntimeToken();
  if (sharedToken) {
    return sharedToken;
  }
  return getFallbackApprovalRuntimeToken();
}

/**
 * Validates a presented loopback approval token without accepting empty or partial matches.
 */
export async function isOperatorApprovalRuntimeToken(
  value: string | null | undefined,
): Promise<boolean> {
  const token = value?.trim();
  if (!token) {
    return false;
  }
  const sharedToken = await readSharedApprovalRuntimeToken();
  if (safeEqualSecret(token, sharedToken)) {
    return true;
  }
  const fallbackToken =
    fallbackApprovalRuntimeToken ?? (sharedToken ? null : getFallbackApprovalRuntimeToken());
  return safeEqualSecret(token, fallbackToken);
}
