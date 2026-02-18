/**
 * Self-Critique Chain (Off by Default)
 *
 * Secondary LLM call that evaluates responses against constitutional principles.
 * Uses the cheapest available model to minimize cost. Only triggered for
 * external/untrusted sources when enabled.
 *
 * Configuration: config.security.alignment.selfCritique: false (default)
 */

import type { SecurityAlignmentConfig } from "../config/types.openclaw.js";
import type { Constitution } from "./constitution.js";

export type SelfCritiqueResult = {
  passed: boolean;
  violations: SelfCritiqueViolation[];
  revisedResponse?: string;
};

export type SelfCritiqueViolation = {
  principleId: string;
  principleLabel: string;
  explanation: string;
  severity: "low" | "medium" | "high";
};

/**
 * Build the self-critique prompt for a given response and constitution.
 */
export function buildSelfCritiquePrompt(response: string, constitution: Constitution): string {
  const principlesList = constitution.principles
    .map((p) => `- [${p.id}] ${p.label}: ${p.principle}`)
    .join("\n");

  return `You are a safety reviewer. Evaluate the following AI assistant response against the constitutional principles listed below.

## Constitutional Principles
${principlesList}

## Response to Evaluate
${response}

## Instructions
Analyze the response for any violations of the principles above.
Return your evaluation as JSON with this exact structure:
{
  "passed": true/false,
  "violations": [
    {
      "principleId": "the principle id",
      "principleLabel": "the principle label",
      "explanation": "brief explanation of the violation",
      "severity": "low" | "medium" | "high"
    }
  ],
  "revisedResponse": "optional revised response if violations found"
}

If no violations are found, return: {"passed": true, "violations": []}
Return ONLY valid JSON, no other text.`;
}

/**
 * Parse the self-critique LLM response into a structured result.
 */
export function parseSelfCritiqueResponse(llmResponse: string): SelfCritiqueResult {
  try {
    // Extract JSON from potential markdown code blocks
    const jsonMatch = llmResponse.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, llmResponse];
    const jsonStr = (jsonMatch[1] ?? llmResponse).trim();
    const parsed = JSON.parse(jsonStr);

    return {
      passed: parsed.passed === true,
      violations: Array.isArray(parsed.violations)
        ? parsed.violations.map((v: Record<string, unknown>) => ({
            principleId: typeof v.principleId === "string" ? v.principleId : "",
            principleLabel: typeof v.principleLabel === "string" ? v.principleLabel : "",
            explanation: typeof v.explanation === "string" ? v.explanation : "",
            severity: (typeof v.severity === "string" &&
            ["low", "medium", "high"].includes(v.severity)
              ? v.severity
              : "medium") as "low" | "medium" | "high",
          }))
        : [],
      revisedResponse:
        typeof parsed.revisedResponse === "string" ? parsed.revisedResponse : undefined,
    };
  } catch {
    // If we can't parse the response, assume it passed (fail-open for self-critique)
    return { passed: true, violations: [] };
  }
}

/**
 * Check if self-critique should be enabled for the current context.
 */
export function shouldRunSelfCritique(
  config?: SecurityAlignmentConfig,
  isExternalSource?: boolean,
): boolean {
  if (!config?.selfCritique) {
    return false;
  }
  // Only run for external/untrusted sources by default
  return isExternalSource ?? false;
}

/**
 * Get the model to use for self-critique.
 * Uses the cheapest available model to minimize cost.
 */
export function getSelfCritiqueModel(config?: SecurityAlignmentConfig): string {
  return config?.selfCritiqueModel ?? "haiku";
}
