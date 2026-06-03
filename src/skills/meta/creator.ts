import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildWorkspaceSkillStatus, resolveSkillStatusEntry } from "../discovery/status.js";
import {
  proposeCreateSkill,
  proposeUpdateSkill,
  resolvePendingSkillProposal,
  reviseSkillProposal,
} from "../workshop/service.js";
import type {
  SkillProposalOrigin,
  SkillProposalReadResult,
  SkillProposalSupportFileInput,
} from "../workshop/types.js";

export const META_SKILL_CREATOR_TOOL_NAME = "meta_skill_creator";
const WORKSHOP_WRITABLE_SKILL_SOURCES = new Set(["openclaw-workspace", "agents-skills-project"]);

export type MetaCreatorProposalInput = {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  name: string;
  description: string;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
  goal?: string;
  evidence?: string;
  origin?: SkillProposalOrigin;
  updateSkillName?: string;
};

async function findPendingProposal(
  input: MetaCreatorProposalInput,
  skillName: string,
): Promise<SkillProposalReadResult | undefined> {
  try {
    return await resolvePendingSkillProposal({
      workspaceDir: input.workspaceDir,
      name: skillName,
    });
  } catch (error) {
    if (formatErrorMessage(error).startsWith("No pending skill proposal matched:")) {
      return undefined;
    }
    throw error;
  }
}

function hasWritableLiveSkill(input: MetaCreatorProposalInput, skillName: string): boolean {
  const status = buildWorkspaceSkillStatus(input.workspaceDir, {
    config: input.config,
    agentId: input.agentId,
  });
  const skill = resolveSkillStatusEntry(status.skills, skillName);
  return Boolean(skill && WORKSHOP_WRITABLE_SKILL_SOURCES.has(skill.source));
}

export async function createSkillProposalFromMetaCreator(
  input: MetaCreatorProposalInput,
): Promise<SkillProposalReadResult> {
  const skillName = input.updateSkillName ?? input.name;
  const pending = await findPendingProposal(input, skillName);
  if (pending) {
    return await reviseSkillProposal({
      workspaceDir: input.workspaceDir,
      config: input.config,
      proposalId: pending.record.id,
      description: input.description,
      content: input.content,
      supportFiles: input.supportFiles,
      goal: input.goal,
      evidence: input.evidence,
    });
  }

  if (input.updateSkillName || hasWritableLiveSkill(input, skillName)) {
    return await proposeUpdateSkill({
      workspaceDir: input.workspaceDir,
      config: input.config,
      agentId: input.agentId,
      skillName,
      description: input.description,
      content: input.content,
      supportFiles: input.supportFiles,
      createdBy: "skill-workshop",
      origin: input.origin,
      goal: input.goal,
      evidence: input.evidence,
    });
  }

  return await proposeCreateSkill({
    workspaceDir: input.workspaceDir,
    name: input.name,
    description: input.description,
    content: input.content,
    supportFiles: input.supportFiles,
    createdBy: "skill-workshop",
    origin: input.origin,
    goal: input.goal,
    evidence: input.evidence,
  });
}
