import { defaultSecurityMatrixPolicy } from "./default-policy.js";
import {
  SECURITY_MATRIX_ACTORS,
  SECURITY_MATRIX_APPROVAL_STATES,
  SECURITY_MATRIX_INFLUENCE_SOURCES,
  SECURITY_MATRIX_OPERATOR_POLICIES,
  SECURITY_MATRIX_TOOL_CAPABILITIES,
  type SecurityMatrixActor,
  type SecurityMatrixApprovalState,
  type SecurityMatrixDecision,
  type SecurityMatrixEvaluation,
  type SecurityMatrixEvaluationInput,
  type SecurityMatrixInfluenceSource,
  type SecurityMatrixOperatorPolicy,
  type SecurityMatrixPolicySource,
  type SecurityMatrixRule,
  type SecurityMatrixToolCapability,
} from "./types.js";

const actorSet = new Set<string>(SECURITY_MATRIX_ACTORS);
const approvalStateSet = new Set<string>(SECURITY_MATRIX_APPROVAL_STATES);
const influenceSourceSet = new Set<string>(SECURITY_MATRIX_INFLUENCE_SOURCES);
const operatorPolicySet = new Set<string>(SECURITY_MATRIX_OPERATOR_POLICIES);
const toolCapabilitySet = new Set<string>(SECURITY_MATRIX_TOOL_CAPABILITIES);

const decisionRank: Record<SecurityMatrixDecision, number> = {
  allow: 0,
  warn: 1,
  require_confirm: 2,
  block: 3,
};

type ResolvedRule = {
  decision: SecurityMatrixDecision;
  reason: string;
  matched: "policy" | "fallback";
};

function normalizeToken(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isSecurityMatrixRule(value: unknown): value is SecurityMatrixRule {
  return (
    typeof value === "object" &&
    value !== null &&
    "decision" in value &&
    "reason" in value &&
    typeof value.decision === "string" &&
    typeof value.reason === "string"
  );
}

function toRule(value: SecurityMatrixDecision | SecurityMatrixRule | undefined): ResolvedRule | undefined {
  if (isSecurityMatrixRule(value)) {
    return { decision: value.decision, reason: value.reason, matched: "policy" };
  }
  if (value) {
    return {
      decision: value,
      reason: "Policy decision matched without a rule reason.",
      matched: "policy",
    };
  }
  return undefined;
}

export function normalizeSecurityMatrixActor(actor: string | undefined): SecurityMatrixActor {
  const normalized = normalizeToken(actor);
  return actorSet.has(normalized) ? (normalized as SecurityMatrixActor) : "unknown";
}

export function normalizeSecurityMatrixInfluenceSource(source: string): SecurityMatrixInfluenceSource {
  const normalized = normalizeToken(source);
  return influenceSourceSet.has(normalized)
    ? (normalized as SecurityMatrixInfluenceSource)
    : "unknown_external";
}

export function normalizeSecurityMatrixCapability(
  capability: string,
): SecurityMatrixToolCapability {
  const normalized = normalizeToken(capability);
  return toolCapabilitySet.has(normalized) ? (normalized as SecurityMatrixToolCapability) : "unknown";
}

export function normalizeSecurityMatrixApprovalState(
  approvalState: string | undefined,
): SecurityMatrixApprovalState {
  const normalized = normalizeToken(approvalState);
  return approvalStateSet.has(normalized) ? (normalized as SecurityMatrixApprovalState) : "none";
}

export function normalizeSecurityMatrixOperatorPolicy(
  operatorPolicy: string | undefined,
): SecurityMatrixOperatorPolicy {
  const normalized = normalizeToken(operatorPolicy);
  return operatorPolicySet.has(normalized) ? (normalized as SecurityMatrixOperatorPolicy) : "unknown";
}

function normalizeInfluences(input: SecurityMatrixEvaluationInput): {
  originalInfluences: readonly string[];
  influencedBy: readonly SecurityMatrixInfluenceSource[];
} {
  const rawInfluences = input.influencedBy ?? (input.source ? [input.source] : []);
  const originalInfluences: string[] = [];
  const influencedBy: SecurityMatrixInfluenceSource[] = [];
  const seen = new Set<SecurityMatrixInfluenceSource>();
  for (const rawSource of rawInfluences) {
    if (typeof rawSource !== "string") {
      continue;
    }
    const normalized = normalizeToken(rawSource);
    if (!normalized || actorSet.has(normalized)) {
      continue;
    }
    originalInfluences.push(rawSource);
    const influence = normalizeSecurityMatrixInfluenceSource(rawSource);
    if (!seen.has(influence)) {
      seen.add(influence);
      influencedBy.push(influence);
    }
  }
  return { originalInfluences, influencedBy };
}

function resolvePolicyRule(params: {
  policySource: SecurityMatrixPolicySource;
  capability: SecurityMatrixToolCapability;
  input: SecurityMatrixEvaluationInput;
}): ResolvedRule {
  const customRule = toRule(params.input.policy?.[params.policySource]?.[params.capability]);
  const defaultRule = toRule(defaultSecurityMatrixPolicy[params.policySource]?.[params.capability]);

  if (customRule && defaultRule && !params.input.allowPolicyWeakening) {
    if (decisionRank[customRule.decision] < decisionRank[defaultRule.decision]) {
      return {
        ...defaultRule,
        reason: `${defaultRule.reason} A weaker custom decision was ignored.`,
      };
    }
  }

  if (customRule) {
    return customRule;
  }
  if (defaultRule) {
    return defaultRule;
  }
  return {
    decision: params.input.defaultDecision ?? "warn",
    reason: "No Security Matrix policy rule matched this source and capability pair.",
    matched: "fallback",
  };
}

function selectStrictestPolicyDecision(params: {
  capability: SecurityMatrixToolCapability;
  influencedBy: readonly SecurityMatrixInfluenceSource[];
  input: SecurityMatrixEvaluationInput;
}): ResolvedRule & { source: SecurityMatrixPolicySource } {
  const policySources: readonly SecurityMatrixPolicySource[] =
    params.influencedBy.length > 0 ? params.influencedBy : ["none"];
  let selected: (ResolvedRule & { source: SecurityMatrixPolicySource }) | undefined;
  for (const policySource of policySources) {
    const candidate = resolvePolicyRule({
      policySource,
      capability: params.capability,
      input: params.input,
    });
    if (!selected || decisionRank[candidate.decision] > decisionRank[selected.decision]) {
      selected = { ...candidate, source: policySource };
    }
  }
  return selected!;
}

export function evaluateSecurityMatrix(
  input: SecurityMatrixEvaluationInput,
): SecurityMatrixEvaluation {
  const actor = normalizeSecurityMatrixActor(input.actor ?? input.source);
  const capability = normalizeSecurityMatrixCapability(input.capability);
  const approvalState = normalizeSecurityMatrixApprovalState(input.approvalState);
  const operatorPolicy = normalizeSecurityMatrixOperatorPolicy(input.operatorPolicy);
  const { influencedBy, originalInfluences } = normalizeInfluences(input);
  const selected = selectStrictestPolicyDecision({ capability, influencedBy, input });
  const baseEvaluation = {
    actor,
    source: selected.source,
    ...(input.source ? { originalSource: input.source } : {}),
    influencedBy,
    originalInfluences,
    capability,
    originalCapability: input.capability,
    approvalState,
    operatorPolicy,
    policyDecision: selected.decision,
  };

  if (operatorPolicy === "denied") {
    return {
      ...baseEvaluation,
      decision: "block",
      reason: "Existing operator policy denied this tool.",
      matched: "operator_policy",
    };
  }

  if (approvalState === "denied") {
    return {
      ...baseEvaluation,
      decision: "block",
      reason: "Explicit approval was denied.",
      matched: "approval_state",
    };
  }

  if (selected.decision === "require_confirm" && approvalState === "approved") {
    return {
      ...baseEvaluation,
      decision: "allow",
      reason: "Explicit approval satisfied a require_confirm decision.",
      matched: "approval_state",
    };
  }

  return {
    ...baseEvaluation,
    decision: selected.decision,
    reason: selected.reason,
    matched: selected.matched,
  };
}

export function explainSecurityMatrixDecision(evaluation: SecurityMatrixEvaluation): string {
  const influence = evaluation.influencedBy.length > 0 ? evaluation.influencedBy.join(",") : "none";
  return `${evaluation.actor} influencedBy=${influence} -> ${evaluation.capability} | policyDecision=${evaluation.policyDecision} | decision=${evaluation.decision} | matched=${evaluation.matched} | ${evaluation.reason}`;
}
