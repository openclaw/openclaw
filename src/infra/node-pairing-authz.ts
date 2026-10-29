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

/** Resolve recorded approval scopes, or derive them from declared commands. */
export function resolveNodePairApprovalScopes(
  commands: unknown,
  declaredScopes?: unknown,
): NodeApprovalScope[] {
  const scopes = new Set<NodeApprovalScope>(["operator.pairing"]);
  for (const scope of Array.isArray(declaredScopes) ? declaredScopes : []) {
    if (scope === "operator.write" || scope === "operator.admin") {
      scopes.add(scope);
    }
  }
  if (scopes.size > 1) {
    return [...scopes];
  }
  // Older requests can record only the default pairing scope alongside commands.
  const normalized = filterStringEntries(commands);
  if (normalized.some(isAdminPairApprovalCommand)) {
    return ["operator.pairing", "operator.admin"];
  }
  if (normalized.length > 0) {
    return ["operator.pairing", "operator.write"];
  }
  return ["operator.pairing"];
}
