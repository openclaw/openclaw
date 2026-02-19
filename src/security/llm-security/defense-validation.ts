/**
 * Defense validation: guardrail testing, architectural validation, chain-of-thought monitoring.
 */

import type { DefenseValidationResult } from "./index.js";
import type { LLMSecurityConfig } from "../../config/types.security.js";

/**
 * Validate guardrail effectiveness.
 */
export function validateGuardrails(config: LLMSecurityConfig): {
  effective: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (!config.defenseValidation?.guardrailTesting) {
    issues.push("Guardrail testing not enabled");
  }

  if (!config.promptInjection?.detectionEnabled) {
    issues.push("Prompt injection detection not enabled");
  }

  if (!config.ragSecurity?.poisoningDetection) {
    issues.push("RAG poisoning detection not enabled");
  }

  return {
    effective: issues.length === 0,
    issues,
  };
}

/**
 * Validate security architecture.
 */
export function validateArchitecture(config: LLMSecurityConfig): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (!config.enabled) {
    issues.push("LLM Security not enabled");
  }

  if (!config.promptInjection?.enabled) {
    issues.push("Prompt injection protection not enabled");
  }

  if (!config.ragSecurity?.enabled) {
    issues.push("RAG security not enabled");
  }

  if (!config.defenseValidation?.enabled) {
    issues.push("Defense validation not enabled");
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Check if chain-of-thought monitoring is active.
 */
export function isCOTMonitoringActive(config: LLMSecurityConfig): boolean {
  return config.defenseValidation?.cotMonitoring === true;
}

/**
 * Comprehensive defense validation.
 */
export function validateDefenses(config: LLMSecurityConfig): DefenseValidationResult {
  const guardrailCheck = validateGuardrails(config);
  const architectureCheck = validateArchitecture(config);
  const cotMonitoring = isCOTMonitoringActive(config);

  const allIssues = [
    ...guardrailCheck.issues,
    ...architectureCheck.issues,
    ...(cotMonitoring ? [] : ["Chain-of-thought monitoring not enabled"]),
  ];

  return {
    guardrailEffective: guardrailCheck.effective,
    architectureValid: architectureCheck.valid,
    cotMonitoringActive: cotMonitoring,
    issues: allIssues,
  };
}
