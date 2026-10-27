import { captureRequesterOrigin } from "../../agents/requester-origin.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import type { ReplyToolAuthorityInput } from "./reply-tool-authority.types.js";

/** Own the policy snapshot without retaining unrelated attempt payloads or callbacks. */
export function captureReplyToolAuthorityInput(
  run: ReplyToolAuthorityInput,
): ReplyToolAuthorityInput {
  const handoff = run.run.trustedInternalHandoff;
  const toolsAllow = run.toolsAllow ? [...run.toolsAllow] : undefined;
  const intersection = run.toolsAllow
    ? readToolAllowlistIntersection(run.toolsAllow)?.map((restriction) => restriction.slice())
    : undefined;
  if (toolsAllow && intersection) {
    attachToolAllowlistIntersection(toolsAllow, intersection);
  }
  return {
    originatingChannel: run.originatingChannel,
    operatorAuthority: run.operatorAuthority,
    toolsAllow,
    disableTools: run.disableTools === true,
    forceRestartSafeTools: run.forceRestartSafeTools === true,
    forceCodeModeTools: run.forceCodeModeTools === true,
    run: {
      // Attempts also carry prompts, replay state, and callbacks; retain only policy inputs.
      sessionId: run.run.sessionId,
      sessionFile: run.run.sessionFile,
      workspaceDir: run.run.workspaceDir,
      provider: run.run.provider,
      model: run.run.model,
      sessionKey: run.run.sessionKey,
      runtimePolicySessionKey: run.run.runtimePolicySessionKey,
      agentId: run.run.agentId,
      agentDir: run.run.agentDir,
      agentAccountId: run.run.agentAccountId,
      operatorProfileId: run.run.operatorProfileId,
      messageProvider: run.run.messageProvider,
      chatType: run.run.chatType,
      conversationId: run.run.conversationId,
      messageThreadId: run.run.messageThreadId,
      groupId: run.run.groupId,
      groupChannel: run.run.groupChannel,
      groupSpace: run.run.groupSpace,
      spawnedBy: run.run.spawnedBy,
      senderId: run.run.senderId,
      senderName: run.run.senderName,
      senderUsername: run.run.senderUsername,
      senderE164: run.run.senderE164,
      senderIsOwner: run.run.senderIsOwner,
      gitContributorProfileId: run.run.gitContributorProfileId,
      cwd: run.run.cwd,
      permissionMode: run.run.permissionMode,
      elevatedLevel: run.run.elevatedLevel,
      traceAuthorized: run.run.traceAuthorized,
      approvalReviewerDeviceId: run.run.approvalReviewerDeviceId,
      authProfileId: run.run.authProfileId,
      authProfileIdSource: run.run.authProfileIdSource,
      requesterOrigin: run.run.requesterOrigin
        ? captureRequesterOrigin({ requesterOrigin: run.run.requesterOrigin })
        : undefined,
      config: run.run.config ? captureRuntimeConfig(run.run.config) : undefined,
      conversationToolPolicy: structuredClone(run.run.conversationToolPolicy),
      inputProvenance: structuredClone(run.run.inputProvenance),
      scheduledToolPolicy: structuredClone(run.run.scheduledToolPolicy),
      runtimePluginToolGrant: structuredClone(run.run.runtimePluginToolGrant),
      // Copy policy facts while retaining the settle owner's live revocation check.
      trustedInternalHandoff: handoff
        ? {
            ...handoff,
            settleBatch: handoff.settleBatch && {
              ...handoff.settleBatch,
              sourceSessionKeys: [...handoff.settleBatch.sourceSessionKeys],
            },
          }
        : undefined,
      toolOverrides: structuredClone(run.run.toolOverrides),
      execOverrides: structuredClone(run.run.execOverrides),
      bashElevated: structuredClone(run.run.bashElevated),
      toolBindings: structuredClone(run.run.toolBindings),
      clientCaps: run.run.clientCaps ? [...run.run.clientCaps] : undefined,
      gatewayUiCommandTarget: structuredClone(run.run.gatewayUiCommandTarget),
      memberRoleIds: run.run.memberRoleIds ? [...run.run.memberRoleIds] : undefined,
    },
  };
}
