import { defaultSecurityMatrixPolicy } from "./default-policy.js";
import {
  SECURITY_MATRIX_TOOL_CAPABILITIES,
  SECURITY_MATRIX_TRUST_SOURCES,
  type SecurityMatrixEvaluation,
  type SecurityMatrixEvaluationInput,
  type SecurityMatrixRule,
  type SecurityMatrixToolCapability,
  type SecurityMatrixTrustSource,
} from "./types.js";

const trustSourceSet = new Set<string>(SECURITY_MATRIX_TRUST_SOURCES);
const toolCapabilitySet = new Set<string>(SECURITY_MATRIX_TOOL_CAPABILITIES);

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

export function normalizeSecurityMatrixSource(source: string): SecurityMatrixTrustSource {
  if (trustSourceSet.has(source)) {
    return source as SecurityMatrixTrustSource;
  }
  return "unknown_external";
}

export function normalizeSecurityMatrixCapability(
  capability: string,
): SecurityMatrixToolCapability {
  if (toolCapabilitySet.has(capability)) {
    return capability as SecurityMatrixToolCapability;
  }
  return "unknown";
}

export function evaluateSecurityMatrix(
  input: SecurityMatrixEvaluationInput,
): SecurityMatrixEvaluation {
  const source = normalizeSecurityMatrixSource(input.source);
  const capability = normalizeSecurityMatrixCapability(input.capability);
  const customRule = input.policy?.[source]?.[capability];
  const defaultRule = defaultSecurityMatrixPolicy[source]?.[capability];
  const rule = customRule ?? defaultRule;

  if (isSecurityMatrixRule(rule)) {
    return {
      source,
      originalSource: input.source,
      capability,
      originalCapability: input.capability,
      decision: rule.decision,
      reason: rule.reason,
      matched: "policy",
    };
  }

  if (rule) {
    return {
      source,
      originalSource: input.source,
      capability,
      originalCapability: input.capability,
      decision: rule,
      reason: "Policy decision matched without a rule reason.",
      matched: "policy",
    };
  }

  return {
    source,
    originalSource: input.source,
    capability,
    originalCapability: input.capability,
    decision: input.defaultDecision ?? "warn",
    reason: "No Security Matrix policy rule matched this source and capability pair.",
    matched: "fallback",
  };
}

export function explainSecurityMatrixDecision(evaluation: SecurityMatrixEvaluation): string {
  return `${evaluation.source} -> ${evaluation.capability} | decision=${evaluation.decision} | matched=${evaluation.matched} | ${evaluation.reason}`;
}
