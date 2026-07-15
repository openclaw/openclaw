import {
  validateSkillsWriteApplyProposalParams,
  validateSkillsWriteDirectParams,
  validateSkillsWriteProposeParams,
  validateSkillsWriteRefreshSnapshotParams,
  validateSkillsWriteValidateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { skillsWriteService } from "../../skills/api/index.js";
import { runSkillsWorkspaceHandler } from "./skills-workspace-handler.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Stable validation, proposal, direct-write, and refresh methods for skill mutations. */
export const skillsWriteHandlers: GatewayRequestHandlers = {
  "skills.write.validate": async ({ params, respond, context }) => {
    await runSkillsWorkspaceHandler({
      method: "skills.write.validate",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsWriteValidateParams,
      run: async (parsedParams, resolved) =>
        skillsWriteService.validate({
          config: resolved.cfg,
          name: parsedParams.name,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
        }),
    });
  },
  "skills.write.propose": async ({ params, respond, context }) => {
    await runSkillsWorkspaceHandler({
      method: "skills.write.propose",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsWriteProposeParams,
      run: (parsedParams, resolved) =>
        parsedParams.kind === "create"
          ? skillsWriteService.propose({
              kind: "create",
              workspaceDir: resolved.workspaceDir,
              config: resolved.cfg,
              name: parsedParams.name,
              description: parsedParams.description,
              content: parsedParams.content,
              supportFiles: parsedParams.supportFiles,
              createdBy: "gateway",
              goal: parsedParams.goal,
              evidence: parsedParams.evidence,
            })
          : skillsWriteService.propose({
              kind: "update",
              workspaceDir: resolved.workspaceDir,
              config: resolved.cfg,
              agentId: resolved.agentId,
              skillName: parsedParams.skillName,
              description: parsedParams.description,
              content: parsedParams.content,
              supportFiles: parsedParams.supportFiles,
              createdBy: "gateway",
              goal: parsedParams.goal,
              evidence: parsedParams.evidence,
            }),
    });
  },
  "skills.write.applyProposal": async ({ params, respond, context }) => {
    await runSkillsWorkspaceHandler({
      method: "skills.write.applyProposal",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsWriteApplyProposalParams,
      run: (parsedParams, resolved) =>
        skillsWriteService.applyProposal({
          workspaceDir: resolved.workspaceDir,
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          reason: parsedParams.reason,
        }),
    });
  },
  "skills.write.direct": async ({ params, respond, context }) => {
    await runSkillsWorkspaceHandler({
      method: "skills.write.direct",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsWriteDirectParams,
      run: (parsedParams, resolved) =>
        skillsWriteService.writeDirect({
          workspaceDir: resolved.workspaceDir,
          config: resolved.cfg,
          mode: parsedParams.mode,
          name: parsedParams.name,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          refresh: parsedParams.refresh,
        }),
    });
  },
  "skills.write.refreshSnapshot": async ({ params, respond, context }) => {
    await runSkillsWorkspaceHandler({
      method: "skills.write.refreshSnapshot",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsWriteRefreshSnapshotParams,
      run: async (_parsedParams, resolved) => ({
        snapshotVersion: skillsWriteService.refreshSnapshot(resolved.workspaceDir),
      }),
    });
  },
};
