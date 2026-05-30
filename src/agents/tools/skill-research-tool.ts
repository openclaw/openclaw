import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
  resolvePendingSkillProposal,
  reviseSkillProposal,
} from "../../skills/workshop/service.js";
import type {
  SkillProposalManifestEntry,
  SkillProposalReadResult,
  SkillProposalStatus,
  SkillProposalSupportFileInput,
} from "../../skills/workshop/types.js";
import { stringEnum } from "../schema/typebox.js";
import {
  asToolParamsRecord,
  readNumberParam,
  readStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";

const SKILL_RESEARCH_ACTIONS = ["create", "update", "revise", "list", "inspect"] as const;
const SKILL_PROPOSAL_STATUSES = [
  "pending",
  "applied",
  "rejected",
  "quarantined",
  "stale",
] as const satisfies readonly SkillProposalStatus[];

const SkillResearchToolSchema = Type.Object(
  {
    action: stringEnum(SKILL_RESEARCH_ACTIONS, {
      description:
        "create for a new skill proposal, update for an existing skill, revise for a pending proposal, list or inspect proposals for proposal discovery.",
    }),
    proposal_id: Type.Optional(
      Type.String({ description: "Existing proposal id for action=inspect or action=revise." }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Skill/proposal name. Required for action=create; optional resolver for action=inspect or action=revise when proposal_id is unknown.",
      }),
    ),
    query: Type.Optional(Type.String({ description: "Optional query for action=list." })),
    status: Type.Optional(
      stringEnum(SKILL_PROPOSAL_STATUSES, {
        description: "Optional proposal status filter for action=list.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Maximum proposals to return for action=list. Defaults to 20.",
      }),
    ),
    description: Type.Optional(
      Type.String({ description: "Skill description for action=create or action=revise." }),
    ),
    skill_name: Type.Optional(
      Type.String({ description: "Existing skill name or key for action=update." }),
    ),
    proposal_content: Type.Optional(
      Type.String({
        description:
          "Full proposed procedure markdown for action=create, action=update, or action=revise. It will be stored as PROPOSAL.md.",
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
        { description: "Optional support files to store with the proposal." },
      ),
    ),
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
      "Create, update, revise, list, or inspect Skill Workshop proposals when reusable procedures should be captured or improved. This tool never applies proposals.",
    parameters: SkillResearchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const action = readStringParam(params, "action", { required: true });

      if (action === "list") {
        const proposals = listProposalEntries({
          proposals: (await listSkillProposals()).proposals,
          status: readProposalStatusParam(params),
          query: readStringParam(params, "query"),
          limit: readListLimitParam(params),
        });
        return {
          content: [{ type: "text", text: formatProposalList(proposals) }],
          details: {
            proposals,
          },
        };
      }

      if (action === "inspect") {
        const proposal = await readProposalForInspect(params);
        return proposalResult(proposal, {
          contentText: formatProposalInspect(proposal),
          includeContent: true,
        });
      }

      const proposalContent = readStringParam(params, "proposal_content", {
        required: true,
        label: "proposal_content",
      });
      const supportFiles = readSupportFilesParam(params);
      const goal = readStringParam(params, "goal");
      const evidence = readStringParam(params, "evidence");

      let proposal: SkillProposalReadResult;
      if (action === "create") {
        proposal = await proposeCreateSkill({
          workspaceDir: options.workspaceDir,
          name: readStringParam(params, "name", { required: true }),
          description: readStringParam(params, "description", { required: true }),
          content: proposalContent,
          supportFiles,
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
          supportFiles,
          createdBy: "skill-research",
          goal,
          evidence,
        });
      } else if (action === "revise") {
        const pendingProposal = await resolvePendingSkillProposal({
          proposalId: readStringParam(params, "proposal_id", {
            label: "proposal_id",
          }),
          name: readStringParam(params, "name"),
        });
        proposal = await reviseSkillProposal({
          workspaceDir: options.workspaceDir,
          proposalId: pendingProposal.record.id,
          content: proposalContent,
          supportFiles,
          description: readStringParam(params, "description"),
          goal,
          evidence,
        });
      } else {
        throw new ToolInputError(`action must be one of ${SKILL_RESEARCH_ACTIONS.join(", ")}`);
      }

      return proposalResult(proposal);
    },
  };
}

function proposalResult(
  proposal: SkillProposalReadResult,
  options: { contentText?: string; includeContent?: boolean } = {},
) {
  return {
    content: options.contentText ? [{ type: "text" as const, text: options.contentText }] : [],
    details: {
      id: proposal.record.id,
      status: proposal.record.status,
      kind: proposal.record.kind,
      skillName: proposal.record.target.skillName,
      skillKey: proposal.record.target.skillKey,
      proposalFile: proposal.record.draftFile,
      supportFileCount: proposal.record.supportFiles?.length ?? 0,
      targetSkillFile: proposal.record.target.skillFile,
      scanState: proposal.record.scan.state,
      proposedVersion: proposal.record.proposedVersion,
      ...(options.includeContent ? { proposalContent: proposal.content } : {}),
    },
  };
}

async function readProposalForInspect(
  params: Record<string, unknown>,
): Promise<SkillProposalReadResult> {
  const proposalId = readStringParam(params, "proposal_id", { label: "proposal_id" });
  if (proposalId) {
    const proposal = await inspectSkillProposal(proposalId);
    if (!proposal) {
      throw new ToolInputError(`Skill proposal not found: ${proposalId}`);
    }
    return proposal;
  }
  return await resolvePendingSkillProposal({
    name: readStringParam(params, "name", { required: true }),
  });
}

function readProposalStatusParam(params: Record<string, unknown>): SkillProposalStatus | undefined {
  const status = readStringParam(params, "status");
  if (!status) {
    return undefined;
  }
  if (!(SKILL_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
    throw new ToolInputError(`status must be one of ${SKILL_PROPOSAL_STATUSES.join(", ")}`);
  }
  return status as SkillProposalStatus;
}

function readListLimitParam(params: Record<string, unknown>): number {
  return (
    readNumberParam(params, "limit", {
      integer: true,
      positiveInteger: true,
      label: "limit",
    }) ?? 20
  );
}

function listProposalEntries(params: {
  proposals: readonly SkillProposalManifestEntry[];
  status?: SkillProposalStatus;
  query?: string;
  limit: number;
}): SkillProposalManifestEntry[] {
  const query = params.query?.trim().toLowerCase();
  const normalizedQuery = query ? normalizeProposalSearchText(query) : undefined;
  const limit = Math.min(Math.max(params.limit, 1), 50);
  return params.proposals
    .filter((proposal) => !params.status || proposal.status === params.status)
    .filter((proposal) => {
      if (!query) {
        return true;
      }
      return [
        proposal.id,
        proposal.title,
        proposal.description,
        proposal.skillName,
        proposal.skillKey,
      ].some((value) => {
        const lower = value.toLowerCase();
        return (
          lower.includes(query) ||
          (!!normalizedQuery && normalizeProposalSearchText(lower).includes(normalizedQuery))
        );
      });
    })
    .toSorted((a, b) => {
      if (a.status === "pending" && b.status !== "pending") {
        return -1;
      }
      if (a.status !== "pending" && b.status === "pending") {
        return 1;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, limit);
}

function normalizeProposalSearchText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function formatProposalList(proposals: readonly SkillProposalManifestEntry[]): string {
  if (proposals.length === 0) {
    return "No skill proposals matched.";
  }
  return proposals
    .map(
      (proposal) =>
        `- ${proposal.id} [${proposal.status}, ${proposal.kind}, ${proposal.scanState}] ${proposal.skillKey}: ${proposal.title}`,
    )
    .join("\n");
}

function formatProposalInspect(proposal: SkillProposalReadResult): string {
  return [
    `Proposal: ${proposal.record.id}`,
    `Status: ${proposal.record.status}`,
    `Kind: ${proposal.record.kind}`,
    `Skill: ${proposal.record.target.skillKey}`,
    `Version: ${proposal.record.proposedVersion}`,
    `Scan: ${proposal.record.scan.state}`,
    "",
    proposal.content,
  ].join("\n");
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
