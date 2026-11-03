import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentSkillsRoot } from "../lifecycle/skill-authoring.js";

/** The plugin manifest's `agentSkillsDir`; discovery loads the same per-agent folder. */
const WORKSHOP_SKILLS_DIR = "workshop-skills";

export function resolveWorkshopSkillsDir(
  config: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveAgentSkillsRoot({ config, agentId, dirName: WORKSHOP_SKILLS_DIR, env });
}

/** Drafts a background review proposed instead of changing skills; discovery never loads them. */
export function resolveWorkshopDraftsDir(
  config: OpenClawConfig,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(resolveWorkshopSkillsDir(config, agentId, env), ".drafts");
}
