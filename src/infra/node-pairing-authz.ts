// Maps node pairing command declarations to required operator scopes.
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_SYSTEM_RUN_COMMANDS,
  isAdminOnlyNodeInvokeCommand,
} from "./node-commands.js";

/** Operator scopes required to approve a pending node pairing surface. */
export type NodeApprovalScope = "operator.pairing" | "operator.write" | "operator.admin";

function isAdminPairApprovalCommand(command: string): boolean {
  return (
    isAdminOnlyNodeInvokeCommand(command) ||
    NODE_SYSTEM_RUN_COMMANDS.some((allowed) => allowed === command) ||
    NODE_EXEC_APPROVALS_COMMANDS.some((allowed) => allowed === command)
  );
}

/** Map declared node commands to the least operator scopes needed for approval. */
export function resolveNodePairApprovalScopes(commands: unknown): NodeApprovalScope[] {
  const normalized = filterStringEntries(commands);
  if (normalized.some(isAdminPairApprovalCommand)) {
    return ["operator.pairing", "operator.admin"];
  }
  if (normalized.length > 0) {
    return ["operator.pairing", "operator.write"];
  }
  return ["operator.pairing"];
}
