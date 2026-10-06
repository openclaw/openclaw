import { hashSkillProposalContent } from "./proposal-hash.js";
import { SKILL_WORKSHOP_ROLLBACK_SCHEMA, type SkillProposalRollback } from "./types.js";

export function createSkillProposalRollback(params: {
  proposalId: string;
  targetSkillFile: string;
  action: "create" | "update";
  previousContent?: string;
  supportFiles?: SkillProposalRollback["supportFiles"];
}): SkillProposalRollback {
  return {
    schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
    proposalId: params.proposalId,
    writtenAt: new Date().toISOString(),
    targetSkillFile: params.targetSkillFile,
    action: params.action,
    ...(params.previousContent !== undefined
      ? {
          previousContent: params.previousContent,
          previousContentHash: hashSkillProposalContent(params.previousContent),
        }
      : {}),
    ...(params.supportFiles ? { supportFiles: params.supportFiles } : {}),
  };
}
