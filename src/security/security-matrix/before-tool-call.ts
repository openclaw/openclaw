import {
  createSecurityMatrixAuditEvent,
  type SecurityMatrixAuditEvent,
  type SecurityMatrixToolFacts,
} from "./facts.js";

export type SecurityMatrixBeforeToolCallAuditConfig = {
  readonly security?: {
    readonly matrix?: {
      readonly audit?: {
        readonly enabled?: boolean;
      };
    };
  };
};

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

export function isSecurityMatrixBeforeToolCallAuditEnabled(
  config: SecurityMatrixBeforeToolCallAuditConfig | undefined,
): boolean {
  return config?.security?.matrix?.audit?.enabled === true;
}

/**
 * Build the Security Matrix audit event shape from facts available at the real
 * before_tool_call boundary. This does not emit, confirm, block, or mutate tool
 * execution; the caller must explicitly opt in and publish the event.
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
    approvalState: facts.approvalState ?? "not_required",
    operatorPolicy: facts.operatorPolicy ?? "unknown",
  });
}
