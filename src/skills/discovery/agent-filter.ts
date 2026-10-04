import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.js";
import { normalizeSkillFilter } from "./filter.js";

type AgentSkillsLimits = {
  maxSkillsPromptChars?: number;
};

type EffectiveAgentSkillFilterSource = {
  filter: string[] | undefined;
  /** Config path that owns the effective allowlist, when one is configured. */
  configPath: string | undefined;
};

function resolveEffectiveAgentSkillFilterSource(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): EffectiveAgentSkillFilterSource {
  if (!cfg) {
    return { filter: undefined, configPath: undefined };
  }
  const agentEntry = agentId ? resolveAgentEntry(cfg, agentId) : undefined;
  if (agentEntry && Object.hasOwn(agentEntry, "skills")) {
    return {
      filter: normalizeSkillFilter(agentEntry.skills),
      configPath: `agents.entries.${agentId}.skills`,
    };
  }
  return {
    filter: normalizeSkillFilter(cfg.agents?.defaults?.skills),
    configPath: "agents.defaults.skills",
  };
}

/**
 * Explicit per-agent skills win when present; otherwise fall back to shared defaults.
 * Unknown agent ids also fall back to defaults so legacy/unresolved callers do not widen access.
 */
export function resolveEffectiveAgentSkillFilter(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): string[] | undefined {
  return resolveEffectiveAgentSkillFilterSource(cfg, agentId).filter;
}

/**
 * Names the agent skill allowlist config path that hides `skillName`, if any.
 *
 * Workshop apply writes into an agent-scoped directory but does not own the
 * operator's `agents.*.skills` allowlist, so callers surface this conflict
 * instead of reporting a bare success. Returns undefined when the skill is
 * unrestricted or already allowed.
 */
export function resolveAgentSkillAllowlistBlockPath(params: {
  config: OpenClawConfig | undefined;
  agentId: string | undefined;
  skillName: string;
}): string | undefined {
  const { filter, configPath } = resolveEffectiveAgentSkillFilterSource(
    params.config,
    params.agentId,
  );
  if (filter === undefined || configPath === undefined || filter.includes(params.skillName)) {
    return undefined;
  }
  return configPath;
}

/** Model/operator-facing explanation for `resolveAgentSkillAllowlistBlockPath`. */
export function formatAgentSkillAllowlistBlockHint(params: {
  configPath: string;
  skillName: string;
}): string {
  return `Note: the agent skill allowlist at "${params.configPath}" does not include "${params.skillName}", so this agent cannot see or use it. Add "${params.skillName}" to that list, or remove the list to allow all skills.`;
}

export function resolveEffectiveAgentSkillsLimits(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): AgentSkillsLimits | undefined {
  if (!cfg || !agentId) {
    return undefined;
  }
  const agentEntry = resolveAgentEntry(cfg, agentId);
  if (!agentEntry || !Object.hasOwn(agentEntry, "skillsLimits")) {
    return undefined;
  }
  const { maxSkillsPromptChars } = agentEntry.skillsLimits ?? {};
  return typeof maxSkillsPromptChars === "number" ? { maxSkillsPromptChars } : undefined;
}

/** Applies a session's sparse skill overlay after agent/default allowlist resolution. */
export function isSessionSkillEnabled(
  skillName: string,
  baseFilter: readonly string[] | undefined,
  overrides: Readonly<Record<string, boolean>> | undefined,
  skillKey = skillName,
): boolean {
  const override =
    overrides && Object.hasOwn(overrides, skillKey) ? overrides[skillKey] : undefined;
  const baseAllows = baseFilter === undefined || baseFilter.includes(skillName);
  return override === true || (baseAllows && override !== false);
}
