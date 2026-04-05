/**
 * Mullusi Governed Skill Registry
 *
 * Skills can only be loaded and installed through this registry, which
 * gates every operation through the Φ governance filter.
 *
 * Flow: register → validate contract → approve → make available
 */

import type { GovernanceGate, GovernanceDecision } from "../kernel/governance.js";
import type { HashChainLedger } from "../kernel/hash-chain.js";
import type { SkillCausalContract } from "./skill-contract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisteredSkill {
  contract: SkillCausalContract;
  /** Timestamp of registration. */
  registeredAt: string;
  /** Hash of the governance approval entry. */
  approvalHash: string;
  /** Whether the skill is currently enabled. */
  enabled: boolean;
}

export interface SkillRegistry {
  /** Register a skill.  Returns the governance decision. */
  register(contract: SkillCausalContract, actor: string): GovernanceDecision;

  /** Unregister a skill by ID. */
  unregister(skillId: string, actor: string): boolean;

  /** Enable a previously registered skill. */
  enable(skillId: string, actor: string): boolean;

  /** Disable a registered skill. */
  disable(skillId: string, actor: string): boolean;

  /** Get a registered skill by ID. */
  get(skillId: string): RegisteredSkill | undefined;

  /** List all registered skills. */
  list(): readonly RegisteredSkill[];

  /** List only enabled skills. */
  listEnabled(): readonly RegisteredSkill[];

  /** Check if a skill is registered and enabled. */
  isAvailable(skillId: string): boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createSkillRegistry(gate: GovernanceGate, ledger: HashChainLedger): SkillRegistry {
  const skills = new Map<string, RegisteredSkill>();

  return {
    register(contract, actor) {
      const decision = gate.evaluate({
        domain: "skill",
        action: `register:${contract.skillId}`,
        actor,
        meta: {
          skillId: contract.skillId,
          allowedTools: contract.allowedTools,
          mutatesState: contract.mutatesState,
        },
      });

      if (decision.verdict === "allow") {
        const entry = ledger.append("skill", `register:${contract.skillId}`, {
          actor,
          contract: {
            skillId: contract.skillId,
            allowedTools: contract.allowedTools,
            requiredConfig: contract.requiredConfig,
            mutatesState: contract.mutatesState,
          },
        });

        skills.set(contract.skillId, {
          contract,
          registeredAt: new Date().toISOString(),
          approvalHash: entry.hash,
          enabled: true,
        });
      }

      return decision;
    },

    unregister(skillId, actor) {
      if (!skills.has(skillId)) return false;
      skills.delete(skillId);
      ledger.append("skill", `unregister:${skillId}`, { actor });
      return true;
    },

    enable(skillId, actor) {
      const skill = skills.get(skillId);
      if (!skill) return false;
      skill.enabled = true;
      ledger.append("skill", `enable:${skillId}`, { actor });
      return true;
    },

    disable(skillId, actor) {
      const skill = skills.get(skillId);
      if (!skill) return false;
      skill.enabled = false;
      ledger.append("skill", `disable:${skillId}`, { actor });
      return true;
    },

    get(skillId) {
      return skills.get(skillId);
    },

    list() {
      return Object.freeze([...skills.values()]);
    },

    listEnabled() {
      return Object.freeze([...skills.values()].filter((s) => s.enabled));
    },

    isAvailable(skillId) {
      const skill = skills.get(skillId);
      return skill !== undefined && skill.enabled;
    },
  };
}
