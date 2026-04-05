/**
 * Mullusi Skill Causal Contract
 *
 * Every skill must declare a causal contract: what it requires, what it
 * produces, and what constraints govern its execution.  This contract is
 * verified by the Φ governance gate before and after skill execution.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A causal contract declares the pre-conditions, post-conditions, and
 * governance constraints for a skill.
 */
export interface SkillCausalContract {
  /** Unique skill identifier. */
  skillId: string;
  /** Human-readable description. */
  description: string;
  /** Tools this skill is allowed to invoke. */
  allowedTools: string[];
  /** Required configuration keys (must exist in session config). */
  requiredConfig: string[];
  /** Required environment variables. */
  requiredEnv: string[];
  /** Minimum authority level needed to invoke this skill. */
  minAuthorityLevel: number;
  /** Whether the skill may mutate persistent state. */
  mutatesState: boolean;
  /** Optional: maximum execution time in milliseconds. */
  timeoutMs?: number;
}

/**
 * Result of executing a skill through the governed pipeline.
 */
export interface GovernedSkillResult {
  skillId: string;
  /** Whether execution was allowed by Φ. */
  allowed: boolean;
  /** Governance reason if denied. */
  denialReason?: string;
  /** Execution output (only if allowed and completed). */
  output?: unknown;
  /** Hash of the governance decision entry. */
  governanceHash: string;
  /** Elapsed time in ms (0 if denied before execution). */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Contract builder (from SKILL.md frontmatter)
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  metadata?: {
    mullusi?: {
      requires?: {
        config?: string[];
        env?: string[];
        bins?: string[];
      };
    };
  };
  "allowed-tools"?: string[];
  "user-invocable"?: string;
  "disable-model-invocation"?: string;
}

/**
 * Build a causal contract from SKILL.md frontmatter.
 * Missing fields get safe defaults (empty arrays, level 0).
 */
export function buildContractFromFrontmatter(
  skillId: string,
  fm: SkillFrontmatter,
): SkillCausalContract {
  return {
    skillId,
    description: fm.description ?? "",
    allowedTools: fm["allowed-tools"] ?? [],
    requiredConfig: fm.metadata?.mullusi?.requires?.config ?? [],
    requiredEnv: fm.metadata?.mullusi?.requires?.env ?? [],
    minAuthorityLevel: 0,
    mutatesState: false,
  };
}
