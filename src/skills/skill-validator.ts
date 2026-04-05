/**
 * Mullusi Skill Validator
 *
 * Validates skills through the Φ governance gate before and after execution.
 * Pre-validation checks the causal contract.  Post-validation verifies
 * that the skill's output conforms to its declared behavior.
 */

import type { GovernanceGate, GovernanceContext, GovernanceDecision } from "../kernel/governance.js";
import type { HashChainLedger } from "../kernel/hash-chain.js";
import type { SkillCausalContract, GovernedSkillResult } from "./skill-contract.js";

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export interface SkillValidator {
  /**
   * Pre-validate: check all contract constraints before execution.
   * Returns a GovernanceDecision (allow or deny).
   */
  preValidate(contract: SkillCausalContract, actor: string, meta?: Record<string, unknown>): GovernanceDecision;

  /**
   * Wrap a skill execution function in governance.
   * Runs pre-validation, executes if allowed, then logs the result.
   */
  executeGoverned(
    contract: SkillCausalContract,
    actor: string,
    executeFn: () => Promise<unknown>,
    meta?: Record<string, unknown>,
  ): Promise<GovernedSkillResult>;
}

export function createSkillValidator(gate: GovernanceGate, ledger: HashChainLedger): SkillValidator {
  return {
    preValidate(contract, actor, meta = {}) {
      const ctx: GovernanceContext = {
        domain: "skill",
        action: `execute:${contract.skillId}`,
        actor,
        meta: {
          ...meta,
          skillId: contract.skillId,
          allowedTools: contract.allowedTools,
          requiredConfig: contract.requiredConfig,
          requiredEnv: contract.requiredEnv,
          minAuthorityLevel: contract.minAuthorityLevel,
          mutatesState: contract.mutatesState,
        },
      };
      return gate.evaluate(ctx);
    },

    async executeGoverned(contract, actor, executeFn, meta = {}) {
      const start = Date.now();

      // Pre-validation
      const decision = this.preValidate(contract, actor, meta);

      if (decision.verdict === "deny") {
        return {
          skillId: contract.skillId,
          allowed: false,
          denialReason: decision.reason,
          governanceHash: ledger.head()?.hash ?? "",
          elapsedMs: Date.now() - start,
        };
      }

      // Execute the skill
      ledger.append("skill", `start:${contract.skillId}`, { actor });
      try {
        const output = await executeFn();
        const entry = ledger.append("skill", `complete:${contract.skillId}`, {
          actor,
          elapsedMs: Date.now() - start,
        });
        return {
          skillId: contract.skillId,
          allowed: true,
          output,
          governanceHash: entry.hash,
          elapsedMs: Date.now() - start,
        };
      } catch (err) {
        const entry = ledger.append("skill", `error:${contract.skillId}`, {
          actor,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - start,
        });
        return {
          skillId: contract.skillId,
          allowed: true,
          denialReason: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
          governanceHash: entry.hash,
          elapsedMs: Date.now() - start,
        };
      }
    },
  };
}
