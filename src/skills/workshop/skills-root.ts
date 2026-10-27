import path from "node:path";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveWorkshopSkillsDir(
  config: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAgentDir(config, agentId, env), "workshop-skills");
}

/** Drafts a background review proposed instead of changing skills; discovery never loads them. */
export function resolveWorkshopDraftsDir(
  config: OpenClawConfig,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(resolveWorkshopSkillsDir(config, agentId, env), ".drafts");
}
