import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { matchesOperatorApprovalReviewerBinding } from "./operator-approval-reviewer-binding.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/types.js";

type OperatorApprovalAccessBinding = {
  reviewerDeviceIds?: readonly string[] | null;
};

/** Whether a client may inspect safe approval projections. */
export function canReviewOperatorApproval(client: GatewayClient | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  if (!scopes.includes(APPROVALS_SCOPE)) {
    return false;
  }
  return Boolean(normalizeOptionalString(client?.connect?.device?.id));
}

/** Whether a client may submit an approval verdict. */
export function canResolveOperatorApproval(client: GatewayClient | null): boolean {
  // approvalRuntime is server-authenticated connection metadata. Public request
  // fields cannot mint this device-less resolver authority.
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const isTrustedApprovalRuntime =
    client?.internal?.approvalRuntime === true && scopes.includes(APPROVALS_SCOPE);
  return isTrustedApprovalRuntime || canReviewOperatorApproval(client);
}

/** Whether a broadly authorized client may access one bound approval record. */
export function canAccessOperatorApproval(params: {
  client: GatewayClient | null;
  binding: OperatorApprovalAccessBinding;
  allowApprovalRuntime?: boolean;
}): boolean {
  const broadlyAuthorized = params.allowApprovalRuntime
    ? canResolveOperatorApproval(params.client)
    : canReviewOperatorApproval(params.client);
  if (!broadlyAuthorized) {
    return false;
  }

  const scopes = Array.isArray(params.client?.connect?.scopes) ? params.client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  if (params.allowApprovalRuntime && params.client?.internal?.approvalRuntime === true) {
    return true;
  }

  return matchesOperatorApprovalReviewerBinding(params.binding, params.client?.connect?.device?.id);
}
