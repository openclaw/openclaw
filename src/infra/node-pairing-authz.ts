// Maps node pairing command declarations to required operator scopes.
// system.run and system.execApprovals.* commands require operator.admin;
// other commands require operator.write; nodes without declared commands
// require only operator.pairing.
import { NODE_EXEC_APPROVALS_COMMANDS, NODE_SYSTEM_RUN_COMMANDS } from "./node-commands.js";

/** Operator scopes required to approve a pending node pairing surface. */
export type NodeApprovalScope = "operator.pairing" | "operator.write" | "operator.admin";

const OPERATOR_PAIRING_SCOPE: NodeApprovalScope = "operator.pairing";
const OPERATOR_WRITE_SCOPE: NodeApprovalScope = "operator.write";
const OPERATOR_ADMIN_SCOPE: NodeApprovalScope = "operator.admin";

/** Map declared node commands to the least operator scopes needed for approval. */
export function resolveNodePairApprovalScopes(commands: unknown): NodeApprovalScope[] {
  const normalized = Array.isArray(commands)
    ? commands.filter((command): command is string => typeof command === "string")
    : [];
  const ADMIN_COMMANDS = [...NODE_SYSTEM_RUN_COMMANDS, ...NODE_EXEC_APPROVALS_COMMANDS];
  if (normalized.some((command) => ADMIN_COMMANDS.some((allowed) => allowed === command))) {
    return [OPERATOR_PAIRING_SCOPE, OPERATOR_ADMIN_SCOPE];
  }
  if (normalized.length > 0) {
    return [OPERATOR_PAIRING_SCOPE, OPERATOR_WRITE_SCOPE];
  }
  return [OPERATOR_PAIRING_SCOPE];
}
