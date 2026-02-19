/**
 * Decision integrity: OODA loop validation and policy checks.
 */

import type { DecisionIntegrityResult } from "./index.js";

export type OODALoopState = {
  observed: boolean;
  oriented: boolean;
  decided: boolean;
  acted: boolean;
};

/**
 * Validate OODA loop completion.
 */
export function validateOODALoop(state: OODALoopState): {
  complete: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  
  if (!state.observed) missing.push("Observe");
  if (!state.oriented) missing.push("Orient");
  if (!state.decided) missing.push("Decide");
  if (!state.acted) missing.push("Act");

  return {
    complete: missing.length === 0,
    missing,
  };
}

/**
 * Check policy compliance.
 */
export function checkPolicyCompliance(options: {
  toolName: string;
  allowedTools: string[];
  sessionKey: string;
  trustTier: string;
}): {
  compliant: boolean;
  reason?: string;
} {
  // Check if tool is allowed
  if (!options.allowedTools.includes(options.toolName)) {
    return {
      compliant: false,
      reason: `Tool ${options.toolName} not in allowed list`,
    };
  }

  // In a real implementation, would check trust tier against tool requirements
  // For now, just return compliant
  return {
    compliant: true,
  };
}

/**
 * Comprehensive decision integrity check.
 */
export function validateDecisionIntegrity(options: {
  oodaLoop: OODALoopState;
  policyCompliant: boolean;
  riskLevel: number;
  riskThreshold: number;
}): DecisionIntegrityResult {
  const oodaCheck = validateOODALoop(options.oodaLoop);
  const issues: string[] = [];

  if (!oodaCheck.complete) {
    issues.push(`OODA loop incomplete: missing ${oodaCheck.missing.join(", ")}`);
  }

  if (!options.policyCompliant) {
    issues.push("Policy compliance check failed");
  }

  if (options.riskLevel >= options.riskThreshold) {
    issues.push(`Risk level ${options.riskLevel} exceeds threshold ${options.riskThreshold}`);
  }

  const valid = oodaCheck.complete && options.policyCompliant && options.riskLevel < options.riskThreshold;

  return {
    valid,
    oodaLoopComplete: oodaCheck.complete,
    policyCompliant: options.policyCompliant,
    riskLevel: options.riskLevel,
    issues,
  };
}
