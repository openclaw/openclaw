import { explainToolAvailability } from "../../agents/tool-availability-explanation.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillWorkshopToolConstructionBlock } from "./tool-availability.js";

const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

type SkillWorkshopToolPolicyDiagnostic = {
  agentId: string;
  source: string;
  detail: string;
  fix: string;
  message: string;
};

function explainSkillWorkshopAvailability(config: OpenClawConfig, agentId?: string) {
  return explainToolAvailability({
    config,
    ...(agentId ? { agentId } : {}),
    toolNames: [SKILL_WORKSHOP_TOOL_NAME],
  });
}

/** True when the agent's tool policy explicitly denies skill_workshop: the agent opted out of Workshop. */
export async function isSkillWorkshopDeniedForAgent(
  config: OpenClawConfig,
  agentId: string,
): Promise<boolean> {
  const [tool] = (await explainSkillWorkshopAvailability(config, agentId)).tools;
  return tool?.available === false && tool.block.stage === "deny";
}

export async function detectSkillWorkshopToolPolicyDiagnostic(params: {
  config: OpenClawConfig;
  workshopEnabled: boolean;
  agentId?: string;
}): Promise<SkillWorkshopToolPolicyDiagnostic | null> {
  if (!params.workshopEnabled) {
    return null;
  }
  const report = await explainSkillWorkshopAvailability(params.config, params.agentId);
  const [tool] = report.tools;
  // A deny is an intentional opt-out, even when a profile excludes the tool first.
  if (tool?.available === false && tool.block.stage === "deny") {
    return null;
  }
  const { agentId, sandbox } = report;
  const prefix = `Skill Workshop is active, but ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)} is hidden for agent ${JSON.stringify(agentId)}:`;
  const constructionBlock = resolveSkillWorkshopToolConstructionBlock({
    sandboxed: sandbox.mode !== "off",
  });
  if (constructionBlock) {
    const detail = `${sandbox.source}: ${JSON.stringify(sandbox.mode)}. ${sandbox.mode === "non-main" ? "In non-main sessions, " : ""}${constructionBlock.detail}`;
    return {
      agentId,
      source: sandbox.source,
      detail,
      fix: constructionBlock.fix,
      message: `${prefix} ${detail} ${constructionBlock.fix}`,
    };
  }
  if (!tool || tool.available) {
    return null;
  }
  const { source = tool.block.stage, detail, fix } = tool.block;
  return { agentId, source, detail, fix, message: `${prefix} ${detail} ${fix}` };
}
