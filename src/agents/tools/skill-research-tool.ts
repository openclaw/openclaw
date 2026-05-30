import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { proposeCreateSkill, proposeUpdateSkill } from "../../skills/workshop/service.js";
import type { SkillProposalReadResult } from "../../skills/workshop/types.js";
import { stringEnum } from "../schema/typebox.js";
import {
  asToolParamsRecord,
  readStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";

const SKILL_RESEARCH_ACTIONS = ["create", "update"] as const;

const SkillResearchToolSchema = Type.Object(
  {
    action: stringEnum(SKILL_RESEARCH_ACTIONS, {
      description: "create for a new skill proposal, update for an existing skill proposal.",
    }),
    name: Type.Optional(Type.String({ description: "New skill name for action=create." })),
    description: Type.Optional(
      Type.String({ description: "New skill description for action=create." }),
    ),
    skill_name: Type.Optional(
      Type.String({ description: "Existing skill name or key for action=update." }),
    ),
    proposal_content: Type.String({
      description: "Full proposed procedure markdown. It will be stored as PROPOSAL.md.",
    }),
    goal: Type.Optional(Type.String({ description: "Research or improvement goal." })),
    evidence: Type.Optional(Type.String({ description: "Short evidence or notes." })),
  },
  { additionalProperties: false },
);

export type SkillResearchToolOptions = {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
};

export function createSkillResearchTool(options: SkillResearchToolOptions): AnyAgentTool {
  return {
    label: "Skill Research",
    name: "skill_research",
    displaySummary: "Propose a reusable skill",
    description:
      "Create a pending Skill Workshop proposal when a reusable procedure is missing or an existing workspace skill needs improvement. This tool never applies proposals.",
    parameters: SkillResearchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const action = readStringParam(params, "action", { required: true });
      const proposalContent = readStringParam(params, "proposal_content", {
        required: true,
        label: "proposal_content",
      });
      const goal = readStringParam(params, "goal");
      const evidence = readStringParam(params, "evidence");

      let proposal: SkillProposalReadResult;
      if (action === "create") {
        proposal = await proposeCreateSkill({
          workspaceDir: options.workspaceDir,
          name: readStringParam(params, "name", { required: true }),
          description: readStringParam(params, "description", { required: true }),
          content: proposalContent,
          createdBy: "skill-research",
          goal,
          evidence,
        });
      } else if (action === "update") {
        proposal = await proposeUpdateSkill({
          workspaceDir: options.workspaceDir,
          config: options.config,
          agentId: options.agentId,
          skillName: readStringParam(params, "skill_name", {
            required: true,
            label: "skill_name",
          }),
          content: proposalContent,
          createdBy: "skill-research",
          goal,
          evidence,
        });
      } else {
        throw new ToolInputError(`action must be one of ${SKILL_RESEARCH_ACTIONS.join(", ")}`);
      }

      return {
        content: [],
        details: {
          id: proposal.record.id,
          status: proposal.record.status,
          kind: proposal.record.kind,
          skillName: proposal.record.target.skillName,
          skillKey: proposal.record.target.skillKey,
          proposalFile: proposal.record.draftFile,
          targetSkillFile: proposal.record.target.skillFile,
          scanState: proposal.record.scan.state,
        },
      };
    },
  };
}
