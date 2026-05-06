import { createOpenClawTools } from "../../agents/openclaw-tools.runtime.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "../../agents/pi-tools.policy.js";
import type { AnyAgentTool } from "../../agents/pi-tools.types.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../../agents/tool-policy-pipeline.js";
import {
  applyOwnerOnlyToolPolicy,
  collectExplicitDenylist,
  collectExplicitAllowlist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../../agents/tool-policy.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { getPluginToolMeta } from "../../plugins/tools.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveGatewayMessageChannel } from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";
import { extractExplicitGroupId } from "./group-id.js";

export function resolveSkillDispatchTools(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  workspaceDir: string;
  provider: string;
  model: string;
  senderId?: string;
  senderIsOwner: boolean;
}): AnyAgentTool[] {
  const channel =
    resolveGatewayMessageChannel(params.ctx.Surface) ??
    resolveGatewayMessageChannel(params.ctx.Provider) ??
    undefined;
  const {
    agentId: resolvedAgentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelProvider: params.provider,
    modelId: params.model,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const groupId = params.sessionEntry?.groupId ?? extractExplicitGroupId(params.ctx.From);
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    spawnedBy: params.sessionEntry?.spawnedBy,
    messageProvider: channel,
    groupId,
    groupChannel: params.sessionEntry?.groupChannel,
    groupSpace: params.sessionEntry?.space,
    accountId: params.ctx.AccountId,
    senderId: params.ctx.SenderId ?? params.senderId,
    senderName: params.ctx.SenderName,
    senderUsername: params.ctx.SenderUsername,
    senderE164: params.ctx.SenderE164,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const subagentPolicy = isSubagentSessionKey(params.sessionKey)
    ? resolveSubagentToolPolicyForSession(params.cfg, params.sessionKey)
    : undefined;
  const tools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: channel,
    agentAccountId: params.ctx.AccountId,
    agentTo: params.ctx.OriginatingTo ?? params.ctx.To,
    agentThreadId: params.ctx.MessageThreadId ?? undefined,
    agentGroupId: groupId,
    agentGroupChannel: params.sessionEntry?.groupChannel,
    agentGroupSpace: params.sessionEntry?.space,
    agentMemberRoleIds: params.ctx.MemberRoleIds,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    allowGatewaySubagentBinding: true,
    requesterAgentIdOverride: params.agentId,
    requesterSenderId: params.senderId,
    senderIsOwner: params.senderIsOwner,
    sessionId: params.sessionEntry?.sessionId,
    modelProvider: params.provider,
    modelId: params.model,
    pluginToolAllowlist: collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      sandboxPolicy,
      subagentPolicy,
    ]),
    pluginToolDenylist: collectExplicitDenylist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      sandboxPolicy,
      subagentPolicy,
    ]),
  }) as AnyAgentTool[];
  const policyFiltered = applyToolPolicyPipeline({
    tools,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: logVerbose,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy: profilePolicyWithAlsoAllow,
        profile,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
        providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
        providerProfile,
        providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        agentId: resolvedAgentId,
      }),
      { policy: sandboxPolicy, label: "sandbox tools.allow" },
      { policy: subagentPolicy, label: "subagent tools.allow" },
    ],
  });
  return applyOwnerOnlyToolPolicy(policyFiltered, params.senderIsOwner) as AnyAgentTool[];
}
