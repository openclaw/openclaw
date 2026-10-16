import type {
  OperatorApprovalDecision,
  OperatorApprovalResolver,
  OperatorApprovalStatus,
  OperatorApprovalTerminalReason,
} from "./operator-approval-store.types.js";

export function operatorApprovalTerminalFields(
  status: Exclude<OperatorApprovalStatus, "pending">,
  terminalReason: OperatorApprovalTerminalReason,
  nowMs: number,
  decision: OperatorApprovalDecision = "deny",
  resolver: OperatorApprovalResolver = { kind: "system", id: null },
) {
  return {
    status,
    decision,
    terminal_reason: terminalReason,
    resolved_at_ms: nowMs,
    resolver_kind: resolver.kind,
    resolver_id: resolver.id,
    updated_at_ms: nowMs,
  };
}
