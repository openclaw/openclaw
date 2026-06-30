// Maps node pairing command declarations to required operator scopes.
import { NODE_SYSTEM_RUN_COMMANDS } from "./node-commands.js";

/** Operator scopes required to approve a pending node pairing surface. */
export type NodeApprovalScope = "operator.pairing" | "operator.write" | "operator.admin";

const OPERATOR_PAIRING_SCOPE: NodeApprovalScope = "operator.pairing";
const OPERATOR_WRITE_SCOPE: NodeApprovalScope = "operator.write";
const OPERATOR_ADMIN_SCOPE: NodeApprovalScope = "operator.admin";

/** True when a declared permission set requires elevated (admin) approval on its own. Granting a
 *  node the `attach` permission lets it mint a grant onto the owner's MAIN session — reaching the
 *  owner's tools + full conversation — so approving it requires operator.admin even when the request
 *  declares no commands (a commandless attach request must NOT be approvable by pairing scope alone). */
export function nodePermissionsRequireAdminApproval(permissions: unknown): boolean {
  return (
    typeof permissions === "object" &&
    permissions !== null &&
    (permissions as Record<string, unknown>).attach === true
  );
}

/** Map declared node commands (+ permissions) to the least operator scopes needed for approval. */
export function resolveNodePairApprovalScopes(
  commands: unknown,
  permissions?: unknown,
): NodeApprovalScope[] {
  const normalized = Array.isArray(commands)
    ? commands.filter((command): command is string => typeof command === "string")
    : [];
  const attachNeedsAdmin = nodePermissionsRequireAdminApproval(permissions);
  if (
    normalized.some((command) => NODE_SYSTEM_RUN_COMMANDS.some((allowed) => allowed === command))
  ) {
    return [OPERATOR_PAIRING_SCOPE, OPERATOR_ADMIN_SCOPE];
  }
  if (normalized.length > 0) {
    return attachNeedsAdmin
      ? [OPERATOR_PAIRING_SCOPE, OPERATOR_WRITE_SCOPE, OPERATOR_ADMIN_SCOPE]
      : [OPERATOR_PAIRING_SCOPE, OPERATOR_WRITE_SCOPE];
  }
  return attachNeedsAdmin
    ? [OPERATOR_PAIRING_SCOPE, OPERATOR_ADMIN_SCOPE]
    : [OPERATOR_PAIRING_SCOPE];
}
