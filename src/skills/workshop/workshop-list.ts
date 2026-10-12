import path from "node:path";
import type { SkillsWorkshopListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { listWorkshopArchive, listWorkshopSkills } from "./library.js";
import { readSkillUsage } from "./skill-usage.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

/** Workshop inventory shared by `skills.workshop.list` and the local CLI fallback. */
export async function buildSkillsWorkshopListResult(params: {
  config: OpenClawConfig;
  agentId: string;
}): Promise<SkillsWorkshopListResult> {
  const { config, agentId } = params;
  const root = resolveWorkshopSkillsDir(config, agentId);
  const [skills, archived] = await Promise.all([
    listWorkshopSkills(config, agentId),
    listWorkshopArchive(config, agentId),
  ]);
  const withFiles = skills.map((skill) => ({
    skill,
    skillFile: canonicalizePath(path.join(root, skill.name, "SKILL.md")),
  }));
  const usage = await readSkillUsage(
    {},
    withFiles.map(({ skillFile }) => skillFile),
  );
  return {
    agentId,
    mode: resolveSkillWorkshopConfig(config).autonomous.mode,
    root,
    skills: withFiles.map(({ skill, skillFile }) => Object.assign(skill, usage.get(skillFile))),
    archived,
  };
}
