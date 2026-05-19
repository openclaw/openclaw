export type NodeApprovalScope = "operator.pairing" | "operator.write" | "operator.admin";

const OPERATOR_PAIRING_SCOPE: NodeApprovalScope = "operator.pairing";

/**
 * Resolves the scopes required to approve a node pairing request.
 *
 * All node approvals require only `operator.pairing` scope. This enables
 * automation workflows (claws, CI) that cannot obtain `operator.admin` scope
 * to provision nodes with exec capabilities.
 *
 * The previous behavior required `operator.admin` for exec-capable nodes,
 * which blocked automation after 2026.5.18's node surface gate.
 *
 * See: https://github.com/openclaw/openclaw/issues/84144
 */
export function resolveNodePairApprovalScopes(_commands: unknown): NodeApprovalScope[] {
  return [OPERATOR_PAIRING_SCOPE];
}
