// Skills inventory assembly and session-scoped response authorization.
import {
  ErrorCodes,
  errorShape,
  validateSkillsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SkillLibrarySelection } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { resolveNodeExecEligibility } from "../../agents/exec-defaults.js";
import { prepareWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import { ensureSkillsWatcher } from "../../skills/runtime/refresh.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { authorizeSessionSharingTarget, resolveSessionSharingTarget } from "../session-sharing.js";
import {
  resolveSkillsAgentWorkspace,
  type ResolvedSkillsWorkspace,
} from "./skills-workspace-handler.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export function buildRemoteAwareWorkspaceSkillStatus(
  resolved: ResolvedSkillsWorkspace,
  selections?: SkillLibrarySelection[],
  skillCardKey?: string,
) {
  // Remote skill availability depends on the agent's executable-node surface,
  // not only the workspace contents, so status reports include live eligibility.
  const nodeSkills = resolveNodeExecEligibility({
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
  const target = params.sessionKey
    ? resolveSessionSharingTarget({
        cfg: resolved.cfg,
        sessionKey: params.sessionKey,
        agentId: resolved.agentId,
      })
    : undefined;
  if (params.sessionKey && !target) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found."));
    return;
  }
  if (target) {
    const denied = authorizeSessionSharingTarget({ cfg: resolved.cfg, client, target });
    if (denied) {
      respond(false, undefined, denied);
      return;
    }
  }
  const sessionId = target?.entry.sessionId;
  ensureSkillsWatcher({
    workspaceDir: resolved.workspaceDir,
    config: resolved.cfg,
    agentId: resolved.agentId,
  });
  const { report } = await buildRemoteAwareWorkspaceSkillStatus(
    resolved,
    target?.entry.skillLibrarySelections,
  );
  if (target && params.sessionKey) {
    // Remote discovery can yield while sharing access or the session changes.
    const cfg = context.getRuntimeConfig();
    const current = resolveSessionSharingTarget({
      cfg,
      sessionKey: params.sessionKey,
      agentId: resolved.agentId,
    });
    if (
      !current ||
      current.entry.sessionId !== sessionId ||
      current.storePath !== target.storePath ||
      current.storeKey !== target.storeKey
    ) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session changed; retry."));
      return;
    }
    const denied = authorizeSessionSharingTarget({ cfg, client, target: current });
    if (denied) {
      respond(false, undefined, denied);
      return;
    }
  }
  respond(true, report, undefined);
};
