import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createSkillProposalFromMetaCreator,
  META_SKILL_CREATOR_TOOL_NAME,
} from "../../skills/meta/creator.js";
import type {
  SkillProposalOrigin,
  SkillProposalRecord,
  SkillProposalSupportFileInput,
} from "../../skills/workshop/types.js";
import {
  asToolParamsRecord,
  readStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";

const MetaSkillCreatorToolSchema = Type.Object(
  {
    name: Type.String({
      description: "Skill name for the proposed reusable workflow.",
    }),
    description: Type.String({
      maxLength: 160,
      description: "Concise skill description for the proposal.",
    }),
    content: Type.String({
      description: "Full proposed SKILL.md body content.",
    }),
    update_skill_name: Type.Optional(
      Type.String({
        description:
          "Optional existing live skill name to update. Without this, the tool revises a same-name pending proposal, updates a same-name writable live skill, or creates a new proposal.",
      }),
    ),
    support_files: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String({
              description:
                "Relative support file path under assets/, examples/, references/, scripts/, or templates/.",
            }),
            content: Type.String({ description: "Support file text content." }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    goal: Type.Optional(Type.String({ description: "Proposal or improvement goal." })),
    evidence: Type.Optional(Type.String({ description: "Short gate evidence or notes." })),
  },
  { additionalProperties: false },
);

export type MetaSkillCreatorToolOptions = {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  origin?: SkillProposalOrigin;
};

export function createMetaSkillCreatorTool(options: MetaSkillCreatorToolOptions): AnyAgentTool {
  return {
    label: "Meta Skill Creator",
    name: META_SKILL_CREATOR_TOOL_NAME,
    displaySummary: "Create or revise a skill proposal",
    description:
      "Create, revise, or update a pending Skill Workshop proposal for a reusable workflow. It never applies proposals or writes active skills directly.",
    parameters: MetaSkillCreatorToolSchema,
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const proposal = await createSkillProposalFromMetaCreator({
        workspaceDir: options.workspaceDir,
        config: options.config,
        agentId: options.agentId,
        name: readStringParam(params, "name", { required: true }),
        description: readStringParam(params, "description", { required: true }),
        content: readStringParam(params, "content", { required: true }),
        updateSkillName: readStringParam(params, "update_skill_name", {
          label: "update_skill_name",
        }),
        supportFiles: readSupportFilesParam(params),
        goal: readStringParam(params, "goal"),
        evidence: readStringParam(params, "evidence"),
        origin: options.origin,
      });

      return proposalResult(proposal.record);
    },
  };
}

function proposalResult(record: SkillProposalRecord) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Prepared skill proposal ${record.id} (${record.status}) for ${record.target.skillKey}.`,
      },
    ],
    details: {
      id: record.id,
      status: record.status,
      kind: record.kind,
      skillName: record.target.skillName,
      skillKey: record.target.skillKey,
      targetSkillFile: record.target.skillFile,
      scanState: record.scan.state,
      proposedVersion: record.proposedVersion,
    },
  };
}

function readSupportFilesParam(
  params: Record<string, unknown>,
): SkillProposalSupportFileInput[] | undefined {
  const raw = params.support_files;
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ToolInputError("support_files must be an array");
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ToolInputError(`support_files[${index}] must be an object`);
    }
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !file.path.trim()) {
      throw new ToolInputError(`support_files[${index}].path required`);
    }
    if (typeof file.content !== "string") {
      throw new ToolInputError(`support_files[${index}].content required`);
    }
    return {
      path: file.path,
      content: file.content,
    };
  });
}
