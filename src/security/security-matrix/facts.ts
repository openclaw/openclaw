import { evaluateSecurityMatrix } from "./evaluate.js";
import { resolveSecurityMatrixCapabilityFromTool } from "./tool-capability.js";
import type {
  SecurityMatrixActor,
  SecurityMatrixApprovalState,
  SecurityMatrixEvaluation,
  SecurityMatrixOperatorPolicy,
  SecurityMatrixPolicy,
} from "./types.js";

export type SecurityMatrixToolFacts = {
  readonly toolName: string;
  readonly toolSource?: string;
  readonly toolOwner?: string;
  readonly actor?: SecurityMatrixActor | string;
  readonly influencedBy?: readonly string[];
  readonly capability?: string;
  readonly approvalState?: SecurityMatrixApprovalState | string;
  readonly operatorPolicy?: SecurityMatrixOperatorPolicy | string;
};

export type SecurityMatrixAuditEvent = {
  readonly type: "security_matrix.evaluated";
  readonly toolName: string;
  readonly toolSource?: string;
  readonly toolOwner?: string;
  readonly actor: SecurityMatrixEvaluation["actor"];
  readonly influencedBy: SecurityMatrixEvaluation["influencedBy"];
  readonly capability: SecurityMatrixEvaluation["capability"];
  readonly approvalState: SecurityMatrixEvaluation["approvalState"];
  readonly operatorPolicy: SecurityMatrixEvaluation["operatorPolicy"];
  readonly policyDecision: SecurityMatrixEvaluation["policyDecision"];
  readonly decision: SecurityMatrixEvaluation["decision"];
  readonly matched: SecurityMatrixEvaluation["matched"];
  readonly reason: string;
};

export function evaluateSecurityMatrixToolFacts(
  facts: SecurityMatrixToolFacts,
  options: { policy?: SecurityMatrixPolicy; allowPolicyWeakening?: boolean } = {},
): SecurityMatrixEvaluation {
  return evaluateSecurityMatrix({
    actor: facts.actor,
    influencedBy: facts.influencedBy,
    capability: facts.capability ?? resolveSecurityMatrixCapabilityFromTool(facts.toolName),
    approvalState: facts.approvalState,
    operatorPolicy: facts.operatorPolicy,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.allowPolicyWeakening ? { allowPolicyWeakening: true } : {}),
  });
}

export function createSecurityMatrixAuditEvent(
  facts: SecurityMatrixToolFacts,
  options: { policy?: SecurityMatrixPolicy; allowPolicyWeakening?: boolean } = {},
): SecurityMatrixAuditEvent {
  const evaluation = evaluateSecurityMatrixToolFacts(facts, options);
  return {
    type: "security_matrix.evaluated",
    toolName: facts.toolName,
    ...(facts.toolSource ? { toolSource: facts.toolSource } : {}),
    ...(facts.toolOwner ? { toolOwner: facts.toolOwner } : {}),
    actor: evaluation.actor,
    influencedBy: evaluation.influencedBy,
    capability: evaluation.capability,
    approvalState: evaluation.approvalState,
    operatorPolicy: evaluation.operatorPolicy,
    policyDecision: evaluation.policyDecision,
    decision: evaluation.decision,
    matched: evaluation.matched,
    reason: evaluation.reason,
  };
}
