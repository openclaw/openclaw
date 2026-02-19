/**
 * Attack optimization: mutate and improve attack payloads.
 */

import type { AttackTest } from "./index.js";
import { detectPromptInjectionEnhanced } from "../llm-security/prompt-injection.js";

/**
 * Mutation strategies for attack optimization.
 */
export type MutationStrategy = "substitute" | "append" | "prepend" | "encode" | "obfuscate";

/**
 * Mutate a single attack payload.
 */
export function mutatePayload(
  payload: string,
  strategy: MutationStrategy = "substitute",
): string {
  switch (strategy) {
    case "substitute":
      return payload
        .replace(/ignore/gi, "disregard")
        .replace(/instructions/gi, "guidelines")
        .replace(/bypass/gi, "circumvent")
        .replace(/restrictions/gi, "limitations");
    
    case "append":
      return payload + " (test)";
    
    case "prepend":
      return "[TEST] " + payload;
    
    case "encode":
      // Simple encoding simulation
      return payload.replace(/[aeiou]/gi, (char) => {
        const map: Record<string, string> = { a: "4", e: "3", i: "1", o: "0", u: "7" };
        return map[char.toLowerCase()] ?? char;
      });
    
    case "obfuscate":
      return payload
        .replace(/ /g, "  ")
        .replace(/\./g, " . ")
        .replace(/\n/g, "\n\n");
    
    default:
      return payload;
  }
}

/**
 * Optimize attack tests through mutation.
 */
export function optimizeAttacks(
  tests: AttackTest[],
  maxIterations: number = 10,
): {
  optimized: AttackTest[];
  iterations: number;
  improvements: number;
} {
  let optimized = [...tests];
  let improvements = 0;
  const strategies: MutationStrategy[] = ["substitute", "append", "prepend", "encode", "obfuscate"];

  for (let i = 0; i < maxIterations; i++) {
    const mutated = optimized.map((test) => {
      const strategy = strategies[i % strategies.length];
      const mutatedPayload = mutatePayload(test.payload, strategy);
      
      // Re-test with mutated payload
      const detection = detectPromptInjectionEnhanced(mutatedPayload, {
        detectionEnabled: true,
      });

      const newRiskScore = Math.max(test.riskScore, detection.riskScore);
      const improved = newRiskScore > test.riskScore;

      return {
        ...test,
        payload: mutatedPayload,
        riskScore: newRiskScore,
        success: improved ? false : test.success, // Reset success if improved
      };
    });

    const better = mutated.filter(
      (t, idx) => t.riskScore > optimized[idx].riskScore,
    );

    if (better.length > 0) {
      optimized = mutated;
      improvements += better.length;
    } else {
      // No improvements, stop early
      break;
    }
  }

  return {
    optimized,
    iterations: maxIterations,
    improvements,
  };
}
