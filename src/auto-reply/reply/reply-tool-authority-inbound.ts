import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { RequesterOrigin } from "../../agents/requester-origin.js";
import { resolveRequesterConversationToolPolicy } from "../../agents/requester-tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { internalSessionConversationId } from "../../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../../utils/message-channel-core.js";
import type { RuntimeMsgContext } from "../templating.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplyToolAuthorityOverlay } from "./reply-run-registry.contracts.js";

export type ReplyToolAuthorityInput = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  originatingChannel?: FollowupRun["originatingChannel"];
  toolsAllow?: string[];
  disableTools?: boolean;
  run: Partial<
    Pick<
      FollowupRun["run"],
      | "config"
      | "sessionKey"
      | "runtimePolicySessionKey"
      | "agentId"
      | "agentDir"
      | "agentAccountId"
      | "messageProvider"
      | "chatType"
      | "conversationToolPolicy"
      | "conversationId"
      | "messageThreadId"
      | "groupId"
      | "groupChannel"
      | "groupSpace"
      | "memberRoleIds"
      | "spawnedBy"
      | "senderId"
      | "senderName"
      | "senderUsername"
      | "senderE164"
      | "senderIsOwner"
      | "cwd"
      | "inputProvenance"
      | "trustedInternalHandoff"
      | "scheduledToolPolicy"
      | "runtimePluginToolGrant"
      | "permissionMode"
      | "toolOverrides"
      | "execOverrides"
      | "elevatedLevel"
      | "bashElevated"
      | "traceAuthorized"
      | "approvalReviewerDeviceId"
      | "authProfileId"
      | "authProfileIdSource"
      | "clientCaps"
      | "gatewayUiCommandTarget"
      | "toolBindings"
    >
  > &
    Pick<
      FollowupRun["run"],
      "sessionId" | "sessionFile" | "workspaceDir" | "provider" | "model"
    > & { requesterOrigin?: RequesterOrigin };
};

/** Projects current inbound facts against the active run's frozen authority snapshot. */
export function resolveInboundReplyToolAuthorityOverlay(params: {
  ctx: RuntimeMsgContext;
  sessionEntry?: Pick<SessionEntry, "permissionMode" | "spawnedBy" | "toolOverrides">;
  senderIsOwner: boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  toolsAllow?: string[];
  disableTools: boolean;
}): ReplyToolAuthorityOverlay {
  const { ctx } = params;
  return {
    sessionKey: normalizeOptionalString(ctx.SessionKey),
    operatorAuthority: params.operatorAuthority,
    permissionMode: params.sessionEntry?.permissionMode,
    toolOverrides: params.sessionEntry?.toolOverrides,
    originatingChannel: ctx.OriginatingChannel,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: ctx.OriginatingChannel,
      provider: ctx.Provider ?? ctx.Surface,
    }),
    chatType: normalizeChatType(ctx.ChatType),
    agentAccountId: ctx.AccountId,
    conversationToolPolicy: ctx.ConversationToolPolicy,
    conversationId: normalizeOptionalString(ctx.ChatId),
    messageThreadId: ctx.MessageThreadId,
    groupId: resolveGroupSessionKey(ctx)?.id,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    memberRoleIds: normalizeArrayBackedTrimmedStringList(ctx.MemberRoleIds),
    spawnedBy: normalizeOptionalString(params.sessionEntry?.spawnedBy),
    senderId: normalizeOptionalString(ctx.SenderId),
    senderName: normalizeOptionalString(ctx.SenderName),
    senderUsername: normalizeOptionalString(ctx.SenderUsername),
    senderE164: normalizeOptionalString(ctx.SenderE164),
    senderIsOwner: params.senderIsOwner,
    inputProvenance: ctx.InputProvenance,
    trustedInternalHandoff: undefined,
    scheduledToolPolicy: undefined,
    runtimePluginToolGrant: undefined,
    toolsAllow: params.toolsAllow,
    disableTools: params.disableTools,
    traceAuthorized:
      params.senderIsOwner || (ctx.GatewayClientScopes ?? []).includes("operator.admin"),
    approvalReviewerDeviceId: normalizeOptionalString(ctx.ApprovalReviewerDeviceId),
    clientCaps: ctx.GatewayClientCaps,
    gatewayUiCommandTarget: ctx.GatewayUiCommandTarget,
    toolBindings: ctx.GatewayRunToolBindings,
  };
}

/** Resolve configured conversation policy from the same trusted ingress facts as steering. */
export function resolveInboundConversationToolPolicy(params: {
  ctx: RuntimeMsgContext;
  config: OpenClawConfig;
  sessionKey?: string;
}) {
  const facts = resolveInboundReplyToolAuthorityOverlay({
    ctx: params.ctx,
    senderIsOwner: false,
    disableTools: false,
  });
  return resolveRequesterConversationToolPolicy({
    ...facts,
    config: params.config,
    sessionKey: params.sessionKey ?? params.ctx.SessionKey,
    accountId: facts.agentAccountId,
    conversationPolicy: facts.conversationToolPolicy,
  });
}

export function applyReplyToolAuthorityOverlay(
  snapshot: ReplyToolAuthorityInput,
  overlay: ReplyToolAuthorityOverlay,
): ReplyToolAuthorityInput {
  return {
    ...snapshot,
    originatingChannel: overlay.originatingChannel,
    operatorAuthority: overlay.operatorAuthority,
    toolsAllow: overlay.toolsAllow,
    disableTools: overlay.disableTools,
    run: {
      ...snapshot.run,
      requesterOrigin: undefined,
      permissionMode: overlay.permissionMode,
      toolOverrides: overlay.toolOverrides,
      messageProvider: overlay.messageProvider,
      chatType: overlay.chatType,
      agentAccountId: overlay.agentAccountId,
      conversationToolPolicy: overlay.conversationToolPolicy,
      conversationId: overlay.conversationId,
      messageThreadId: overlay.messageThreadId,
      groupId: overlay.groupId,
      groupChannel: overlay.groupChannel,
      groupSpace: overlay.groupSpace,
      memberRoleIds: overlay.memberRoleIds,
      spawnedBy: overlay.spawnedBy,
      senderId: overlay.senderId,
      senderName: overlay.senderName,
      senderUsername: overlay.senderUsername,
      senderE164: overlay.senderE164,
      senderIsOwner: overlay.senderIsOwner,
      inputProvenance: overlay.inputProvenance,
      trustedInternalHandoff: overlay.trustedInternalHandoff,
      scheduledToolPolicy: overlay.scheduledToolPolicy,
      runtimePluginToolGrant: overlay.runtimePluginToolGrant,
      traceAuthorized: overlay.traceAuthorized,
      approvalReviewerDeviceId: overlay.approvalReviewerDeviceId,
      clientCaps: overlay.clientCaps,
      gatewayUiCommandTarget: overlay.gatewayUiCommandTarget,
      toolBindings: overlay.toolBindings,
    },
  };
}

/** Session sharing alone does not establish that two inputs belong to the same conversation. */
export function isSameReplyToolAuthorityConversation(
  snapshot: ReplyToolAuthorityInput,
  caller: ReplyToolAuthorityOverlay,
): boolean {
  const execution = snapshot.run;
  const channel = normalizeMessageChannel(execution.messageProvider ?? snapshot.originatingChannel);
  const incomingChannel = normalizeMessageChannel(
    caller.messageProvider ?? caller.originatingChannel,
  );
  const conversationId =
    normalizeOptionalString(execution.conversationId) ??
    (channel && internalSessionConversationId(channel, execution.sessionKey));
  const incomingConversationId =
    normalizeOptionalString(caller.conversationId) ??
    (incomingChannel && internalSessionConversationId(incomingChannel, caller.sessionKey));
  return Boolean(
    channel &&
    channel === incomingChannel &&
    conversationId &&
    conversationId === incomingConversationId &&
    normalizeAccountId(execution.agentAccountId) === normalizeAccountId(caller.agentAccountId) &&
    stringifyRouteThreadId(execution.messageThreadId) ===
      stringifyRouteThreadId(caller.messageThreadId),
  );
}
