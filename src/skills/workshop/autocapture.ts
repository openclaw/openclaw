import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { listSkillProposals, proposeCreateSkill, proposeUpdateSkill } from "./service.js";
import { extractDurableInstructionProposal } from "./signals.js";
import { readWorkspaceSkillFile, resolveSkillProposalTarget } from "./store.js";

type SkillWorkshopAgentEndEvent = {
  messages: unknown[];
  success?: boolean;
};

type SkillWorkshopAgentContext = {
  agentId?: string;
  workspaceDir?: string;
};

const log = createSubsystemLogger("skills/workshop");

export async function runSkillWorkshopAutoCapture(params: {
  event: SkillWorkshopAgentEndEvent;
  ctx: SkillWorkshopAgentContext;
  config?: OpenClawConfig;
}): Promise<void> {
  const config = resolveSkillWorkshopConfig(params.config);
  if (!config.autonomous.enabled) {
    return;
  }
  if (params.event.success === false) {
    return;
  }
  const workspaceDir = params.ctx.workspaceDir;
  if (!workspaceDir) {
    return;
  }

  const proposal = extractDurableInstructionProposal({ messages: params.event.messages });
  if (!proposal) {
    return;
  }
  if (Buffer.byteLength(proposal.content, "utf8") > config.maxSkillBytes) {
    log.warn(`skill workshop auto-capture skipped oversized proposal: ${proposal.skillName}`);
    return;
  }

  const manifest = await listSkillProposals({ workspaceDir });
  const activeProposals = manifest.proposals.filter(
    (entry) => entry.status === "pending" || entry.status === "quarantined",
  );
  if (activeProposals.length >= config.maxPending) {
    log.warn("skill workshop auto-capture skipped because pending proposal limit was reached");
    return;
  }
  if (activeProposals.some((entry) => entry.skillKey === proposal.skillName)) {
    return;
  }

  try {
    const target = resolveSkillProposalTarget({
      workspaceDir,
      skillName: proposal.skillName,
    });
    const existingSkill = await readWorkspaceSkillFile(target.skillFile);
    const result =
      existingSkill === null
        ? await proposeCreateSkill({
            workspaceDir,
            name: proposal.skillName,
            description: proposal.description,
            content: proposal.content,
            createdBy: "skill-workshop",
            goal: proposal.goal,
            evidence: proposal.evidence,
          })
        : await proposeUpdateSkill({
            workspaceDir,
            config: params.config,
            agentId: params.ctx.agentId,
            skillName: proposal.skillName,
            content: proposal.content,
            createdBy: "skill-workshop",
            goal: proposal.goal,
            evidence: proposal.evidence,
          });
    log.info(`skill workshop auto-capture queued ${result.record.target.skillKey}`);
  } catch (error) {
    log.warn(`skill workshop auto-capture skipped: ${String(error)}`);
  }
}
