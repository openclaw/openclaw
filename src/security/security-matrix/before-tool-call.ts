import {
  createSecurityMatrixAuditEvent,
  type SecurityMatrixAuditEvent,
  type SecurityMatrixToolFacts,
} from "./facts.js";

export type SecurityMatrixBeforeToolCallFacts = Omit<
  SecurityMatrixToolFacts,
  "actor" | "approvalState" | "operatorPolicy"
> & {
  /** Real runtime actor requesting this tool call. Defaults to agent for model-requested calls. */
  readonly actor?: SecurityMatrixToolFacts["actor"];
  /** Approval state observed at the before_tool_call boundary. */
  readonly approvalState?: SecurityMatrixToolFacts["approvalState"];
  /** Existing operator or hook policy result observed at the before_tool_call boundary. */
  readonly operatorPolicy?: SecurityMatrixToolFacts["operatorPolicy"];
};

/**
 * Build the Security Matrix audit event shape from facts available at the real
 * before_tool_call boundary. This helper is observe-only: it does not confirm,
 * block, mutate params, or change trusted policy decisions.
 */
export function createSecurityMatrixBeforeToolCallAuditEvent(
  facts: SecurityMatrixBeforeToolCallFacts,
): SecurityMatrixAuditEvent {
  return createSecurityMatrixAuditEvent({
    toolName: facts.toolName,
    ...(facts.toolSource ? { toolSource: facts.toolSource } : {}),
    ...(facts.toolOwner ? { toolOwner: facts.toolOwner } : {}),
    actor: facts.actor ?? "agent",
    influencedBy: facts.influencedBy ?? [],
    ...(facts.capability ? { capability: facts.capability } : {}),
    approvalState: facts.approvalState ?? "none",
    operatorPolicy: facts.operatorPolicy ?? "unknown",
  });
}
