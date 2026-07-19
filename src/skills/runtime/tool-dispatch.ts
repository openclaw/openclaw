// Skill tool dispatch routes runtime skill tool calls through the active session context.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../../agents/agent-tools.policy.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import { createOpenClawTools } from "../../agents/openclaw-tools.runtime.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSenderToolPolicy } from "../../agents/sender-tool-policy.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../agents/subagent-capabilities.js";
import { buildDeclaredToolAllowlistContext } from "../../agents/tool-policy-declared-context.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../../agents/tool-policy-pipeline.js";
import {
  collectExplicitDenylist,
  collectExplicitAllowlist,
  hasRestrictiveAllowPolicy,
  mergeAlsoAllowPolicy,
  replaceWithEffectiveToolAllowlist,
  resolveToolProfilePolicy,
} from "../../agents/tool-policy.js";
import {
  replaceWithEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
} from "../../agents/tools/cron-tool.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { getPluginToolMeta } from "../../plugins/tools.js";
import { classifyTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { normalizeAccountId, normalizeOptionalAccountId } from "../../routing/account-id.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveGatewayMessageChannel } from "../../utils/message-channel.js";
import type { SkillCommandSpec } from "../types.js";

type SkillDispatchMessageContext = {
  surface?: string;
  provider?: string;
  accountId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  senderIsOwner?: boolean;
  isAuthorizedSender?: boolean;
  originatingTo?: string;
  to?: string;
  nativeChannelId?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
  memberRoleIds?: string[];
};

/**
 * Policy-enforcement seam for skill `command-dispatch: tool` invocations.
 * Keep this aligned with the normal tool surfaces so GHSA-mhm4-93fw-4qr2
 * stays closed across allow/deny, group, sandbox, and subagent policy layers.
 */
export function resolveSkillDispatchTools(params: {
  message: SkillDispatchMessageContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  workspaceDir: string;
  provider: string;
  model: string;
  runId?: string;
  senderId?: string;
  currentChannelId?: string;
  skillCommand?: Pick<SkillCommandSpec, "name" | "skillFile" | "skillName" | "skillSource"> & {
    toolName?: string;
  };
  groupId?: string;
  /** Immutable host authority admitted for this command turn. */
  turnAuthority?: TurnAuthoritySnapshot;
}): AnyAgentTool[] {
  const routeChannel =
    resolveGatewayMessageChannel(params.message.surface) ??
    resolveGatewayMessageChannel(params.message.provider) ??
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
  const classifiedAuthority = classifyTurnAuthoritySnapshot(params.turnAuthority);
  if (classifiedAuthority.kind !== "issued") {
    logVerbose(`Skill command tool dispatch blocked: ${classifiedAuthority.kind} turn authority`);
    return [];
  }
  const turnAuthority = classifiedAuthority.snapshot;
  const turnAuthorization = turnAuthority.authorization;
  const authorityAgentId = normalizeOptionalString(turnAuthorization.agentId);
  const executionSessionKey = normalizeOptionalString(params.sessionKey);
  const authoritySessionKey = normalizeOptionalString(turnAuthorization.sessionKey);
  const executionSessionId = normalizeOptionalString(params.sessionEntry?.sessionId);
  const authoritySessionId = normalizeOptionalString(turnAuthorization.sessionId);
  const executionRunId = normalizeOptionalString(params.runId);
  const authorityRunId = normalizeOptionalString(turnAuthorization.runId);
  if (
    !resolvedAgentId ||
    !authorityAgentId ||
    normalizeAgentId(authorityAgentId) !== resolvedAgentId ||
    !executionSessionKey ||
    authoritySessionKey !== executionSessionKey ||
    authoritySessionId !== executionSessionId ||
    authorityRunId !== executionRunId
  ) {
    logVerbose("Skill command tool dispatch blocked: turn authority execution mismatch");
    return [];
  }

  const principal = turnAuthorization.principal;
  if (principal.kind === "unknown") {
    logVerbose("Skill command tool dispatch blocked: unknown turn authority principal");
    return [];
  }

  let deliveryChannel = routeChannel;
  let deliveryAccountId = params.message.accountId;
  let deliveryConversationId =
    normalizeOptionalString(params.message.nativeChannelId) ??
    normalizeOptionalString(params.message.originatingTo) ??
    normalizeOptionalString(params.message.to) ??
    executionSessionKey;
  let deliveryThreadId = params.message.messageThreadId;
  let groupId = params.sessionEntry?.groupId ?? params.groupId;
  if (principal.kind === "sender") {
    const authorityChannel = resolveGatewayMessageChannel(principal.provider);
    const authorityAccountId = normalizeOptionalAccountId(principal.accountId);
    const authorityConversationId = normalizeOptionalString(turnAuthorization.conversationId);
    const routeParentConversationId = normalizeOptionalString(params.message.threadParentId);
    const authorityParentConversationId = normalizeOptionalString(
      turnAuthorization.parentConversationId,
    );
    const routeThreadId = stringifyRouteThreadId(params.message.messageThreadId);
    const authorityThreadId = stringifyRouteThreadId(turnAuthorization.threadId);
    if (
      !routeChannel ||
      !authorityChannel ||
      routeChannel !== authorityChannel ||
      !authorityAccountId ||
      authorityAccountId !== normalizeAccountId(params.message.accountId) ||
      !deliveryConversationId ||
      !authorityConversationId ||
      deliveryConversationId !== authorityConversationId ||
      routeParentConversationId !== authorityParentConversationId ||
      routeThreadId !== authorityThreadId
    ) {
      logVerbose("Skill command tool dispatch blocked: sender authority route mismatch");
      return [];
    }
    // After exact admission checks, carry only host-issued route facts forward.
    // Mutable message siblings must not select another account, group, or thread.
    deliveryChannel = authorityChannel;
    deliveryAccountId = authorityAccountId;
    deliveryConversationId = authorityConversationId;
    deliveryThreadId = turnAuthorization.threadId;
    groupId = authorityConversationId;
  }

  const senderId = principal.kind === "sender" ? principal.senderId : undefined;
  const senderName = principal.kind === "sender" ? principal.aliases?.name : undefined;
  const senderUsername = principal.kind === "sender" ? principal.aliases?.username : undefined;
  const senderE164 = principal.kind === "sender" ? principal.aliases?.e164 : undefined;
  const senderIsOwner =
    principal.kind === "sender"
      ? principal.senderIsOwner
      : principal.kind === "operator"
        ? principal.isOwner
        : undefined;
  const memberRoleIds = principal.kind === "sender" ? [...(principal.roleIds ?? [])] : undefined;
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    spawnedBy: params.sessionEntry?.spawnedBy,
    messageProvider: deliveryChannel,
    senderMessageProvider: principal.kind === "sender" ? deliveryChannel : undefined,
    groupId,
    groupChannel: params.sessionEntry?.groupChannel,
    groupSpace: params.sessionEntry?.space,
    accountId: deliveryAccountId,
    senderId,
    senderName,
    senderUsername,
    senderE164,
  });
  const senderPolicy = resolveSenderToolPolicy({
    config: params.cfg,
    agentId: resolvedAgentId,
    messageProvider: principal.kind === "sender" ? deliveryChannel : undefined,
    senderId,
    senderName,
    senderUsername,
    senderE164,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const subagentStore = resolveSubagentCapabilityStore(params.sessionKey, {
    cfg: params.cfg,
  });
  const subagentPolicy = isSubagentEnvelopeSession(params.sessionKey, {
    cfg: params.cfg,
    store: subagentStore,
  })
    ? resolveSubagentToolPolicyForSession(params.cfg, params.sessionKey, {
        store: subagentStore,
      })
    : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(params.cfg, params.sessionKey, {
    store: subagentStore,
  });
  const explicitPolicyList = [
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    senderPolicy,
    sandboxPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  ];
  const explicitDenylist = collectExplicitDenylist(explicitPolicyList);
  const inheritedToolAllowlist: string[] = [];
  const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
  const shouldCaptureCronCreatorToolAllowlist =
    explicitPolicyList.some(hasRestrictiveAllowPolicy) || explicitDenylist.length > 0;
  const beforeToolCallHookContext = {
    cwd: params.workspaceDir,
    workspaceDir: params.workspaceDir,
    authorization: turnAuthorization,
    ...(params.sessionEntry?.skillsSnapshot
      ? { skillsSnapshot: params.sessionEntry.skillsSnapshot }
      : {}),
    ...(params.skillCommand
      ? {
          skillCommand: {
            commandName: params.skillCommand.name,
            ...(params.skillCommand.skillFile ? { skillFile: params.skillCommand.skillFile } : {}),
            skillName: params.skillCommand.skillName,
            skillSource: params.skillCommand.skillSource ?? "unknown",
            ...(params.skillCommand.toolName ? { toolName: params.skillCommand.toolName } : {}),
          },
        }
      : {}),
  };
  const tools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    runId: executionRunId,
    agentChannel: deliveryChannel,
    agentAccountId: deliveryAccountId,
    agentTo: deliveryConversationId,
    agentThreadId: deliveryThreadId,
    nativeChannelId: deliveryConversationId,
    agentGroupId: groupId,
    agentGroupChannel: params.sessionEntry?.groupChannel,
    agentGroupSpace: params.sessionEntry?.space,
    agentMemberRoleIds: memberRoleIds,
    senderIsOwner,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    allowGatewaySubagentBinding: true,
    sandboxed: sandboxRuntime.sandboxed,
    requesterAgentIdOverride: params.agentId,
    requesterSenderId: senderId,
    sessionId: params.sessionEntry?.sessionId,
    currentChannelId: deliveryConversationId,
    authorization: turnAuthorization,
    turnAuthority,
    beforeToolCallHookContext,
    modelProvider: params.provider,
    modelId: params.model,
    pluginToolAllowlist: collectExplicitAllowlist(explicitPolicyList),
    pluginToolDenylist: explicitDenylist,
    cronCreatorToolAllowlist: shouldCaptureCronCreatorToolAllowlist
      ? cronCreatorToolAllowlist
      : undefined,
    inheritedToolAllowlist,
    inheritedToolDenylist: explicitDenylist,
  });
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
        senderPolicy,
        agentId: resolvedAgentId,
      }),
      { policy: sandboxPolicy, label: "sandbox tools.allow" },
      { policy: subagentPolicy, label: "subagent tools.allow" },
      { policy: inheritedToolPolicy, label: "inherited tools" },
    ],
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      toolDenylist: explicitDenylist,
    }),
  });
  if (explicitPolicyList.some(hasRestrictiveAllowPolicy)) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, policyFiltered);
  }
  if (shouldCaptureCronCreatorToolAllowlist) {
    replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlist, policyFiltered, (tool) =>
      getPluginToolMeta(tool),
    );
  }
  return policyFiltered;
}
