// Agent skill filter helpers select skills that apply to a configured agent.
import type { OpenClawConfig } from "../../config/types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeSkillFilter, resolveComposedSkillFilter } from "./filter.js";

type AgentSkillsLimits = {
  maxSkillsPromptChars?: number;
};

function resolveAgentEntry(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number] | undefined {
  if (!cfg) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  return cfg.agents?.list?.find((entry) => normalizeAgentId(entry.id) === normalizedAgentId);
}

/**
 * Explicit per-agent skills win when present; otherwise merge or fall back to shared defaults.
 * Unknown agent ids also fall back to defaults so legacy/unresolved callers do not widen access.
 */
export function resolveEffectiveAgentSkillFilter(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): string[] | undefined {
  if (!cfg) {
    return undefined;
  }
  const agentEntry = resolveAgentEntry(cfg, agentId);
  if (agentEntry) {
    return resolveComposedSkillFilter(agentEntry, cfg.agents?.defaults?.skills);
  }
  return normalizeSkillFilter(cfg.agents?.defaults?.skills);
}

export function resolveEffectiveAgentSkillsLimits(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): AgentSkillsLimits | undefined {
  if (!agentId) {
    return undefined;
  }
  const agentEntry = resolveAgentEntry(cfg, agentId);
  if (!agentEntry || !Object.hasOwn(agentEntry, "skillsLimits")) {
    return undefined;
  }
  const { maxSkillsPromptChars } = agentEntry.skillsLimits ?? {};
  return typeof maxSkillsPromptChars === "number" ? { maxSkillsPromptChars } : undefined;
}
