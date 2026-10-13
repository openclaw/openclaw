import {
  ErrorCodes,
  errorShape,
  validateSkillsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SkillLibrarySelection } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { resolveNodeExecEligibilityAsync } from "../../agents/exec-defaults.js";
import { prepareWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import { ensureSkillsWatcher } from "../../skills/runtime/refresh.js";
import { prepareRemoteSkillConnections } from "../../skills/runtime/remote-skills.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { withSessionDiscoveryAccess } from "./session-discovery-access.js";
import {
  resolveSkillsAgentWorkspace,
  type ResolvedSkillsWorkspace,
} from "./skills-workspace-handler.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export async function buildRemoteAwareWorkspaceSkillStatus(
  resolved: ResolvedSkillsWorkspace,
  selections?: SkillLibrarySelection[],
  skillCardKey?: string,
) {
  await prepareRemoteSkillConnections();
  // Remote skill availability depends on the agent's executable-node surface,
  // not only the workspace contents, so status reports include live eligibility.
  const nodeSkills = await resolveNodeExecEligibilityAsync({
    cfg: resolved.cfg,
    agentId: resolved.agentId,
  });
  return prepareWorkspaceSkillStatus(resolved.workspaceDir, {
    librarySelections: selections,
    skillCardKey,
    config: resolved.cfg,
    agentId: resolved.agentId,
    eligibility: {
      nodeSkills,
      remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec }),
    },
  });
}

export const handleSkillsStatus: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
  signal,
  hasCurrentClientAuthority,
}) => {
  if (!assertValidParams(params, validateSkillsStatusParams, "skills.status", respond)) {
    return;
  }
  const agentId = params.agentId ?? tryResolveAmbientOwnerAgentId(context.getRuntimeConfig());
  const resolved = resolveSkillsAgentWorkspace({ ...params, agentId }, context);
  if (!resolved.ok) {
    respond(false, undefined, resolved.error);
    return;
  }
  await withSessionDiscoveryAccess(
    {
      client,
      context,
      respond,
      signal,
      hasCurrentClientAuthority,
      sessionKey: params.sessionKey,
      agentId: resolved.agentId,
      changedError: errorShape(ErrorCodes.INVALID_REQUEST, "Session changed; retry."),
    },
    async (entry) => {
      ensureSkillsWatcher({
        workspaceDir: resolved.workspaceDir,
        config: resolved.cfg,
        agentId: resolved.agentId,
      });
      const { report } = await buildRemoteAwareWorkspaceSkillStatus(
        resolved,
        entry?.skillLibrarySelections,
      );
      return report;
    },
  );
};
