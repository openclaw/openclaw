import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.js";

type AgentSkillsLimits = {
  maxSkillsPromptChars?: number;
};

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

/** Applies a session's focused selection and sparse overlay; eligibility gates remain separate. */
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
