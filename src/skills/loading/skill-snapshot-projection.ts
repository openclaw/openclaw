import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveEffectiveAgentSkillsLimits } from "../discovery/agent-filter.js";
import { isSkillPromptVisible } from "../discovery/skill-index.js";
import { resolveSkillFileHost } from "../skill-file-host.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import { resolveSkillKey } from "./frontmatter.js";
import { compactPromptSkills } from "./skill-paths.js";
import { prepareSkillsForPrompt } from "./skill-prompt-limits.js";

export type SkillSnapshotProjectionInput = {
  workspaceDir: string;
  eligible: SkillEntry[];
  skillFilter?: string[];
  config?: OpenClawConfig;
  agentId?: string;
  skillOverrides?: Record<string, boolean>;
  eligibility?: {
    nodeSkills?: SkillEligibilityContext["nodeSkills"];
    remote?: { note?: string };
  };
  preserveEntryOrder?: boolean;
  snapshotVersion?: number;
};

/** Render already selected entries without repeating discovery or eligibility checks. */
export function buildSkillSnapshotProjection(input: SkillSnapshotProjectionInput): SkillSnapshot {
  const { eligible, skillFilter } = input;
  const promptEntries = eligible.filter(isSkillPromptVisible);
  const remoteNote = input.eligibility?.remote?.note?.trim();
  const resolvedSkills = promptEntries.map((entry) => entry.skill);
  const limits = input.config?.skills?.limits;
  const agentLimits = resolveEffectiveAgentSkillsLimits(input.config, input.agentId);
  const prepared = prepareSkillsForPrompt({
    skills: compactPromptSkills(resolvedSkills),
    maxSkillsInPrompt: limits?.maxSkillsInPrompt,
    maxSkillsPromptChars: agentLimits?.maxSkillsPromptChars ?? limits?.maxSkillsPromptChars,
    remoteNote,
    preserveOrder: input.preserveEntryOrder,
  });
  const byName = new Map(resolvedSkills.map((skill) => [skill.name, skill]));
  return {
    prompt: prepared.prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      source: { filePath: entry.skill.filePath, fileHost: resolveSkillFileHost(entry.skill) },
      gatewayFilePath:
        resolveSkillFileHost(entry.skill) === "gateway" ? entry.skill.filePath : undefined,
      skillKey: resolveSkillKey(entry),
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),
    })),
    ...(skillFilter === undefined ? {} : { skillFilter }),
    ...(input.skillOverrides ? { skillOverrides: input.skillOverrides } : {}),
    ...(input.eligibility?.nodeSkills
      ? { nodeSkillsEligibility: input.eligibility.nodeSkills }
      : {}),
    resolvedSkills: prepared.skills.map((skill) => byName.get(skill.name)!),
    discoverySkills: resolvedSkills,
    version: input.snapshotVersion,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  };
}
