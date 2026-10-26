import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { ReplyToolAuthorityCaller } from "../../agents/harness/host-private-capabilities.js";
import {
  captureRequesterOrigin,
  resolveRequesterPrincipalKey,
} from "../../agents/requester-origin.js";
import { resolveRequesterConversationToolPolicy } from "../../agents/requester-tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import type {
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRequester,
} from "../../sessions/session-controller.contracts.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import { internalSessionConversationId } from "../../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../../utils/message-channel-core.js";
import { getRequesterProfile } from "../requester-profile.js";
import { shouldUseFromAsSenderFallback } from "../sender-identity.js";
import type { RuntimeMsgContext } from "../templating.js";
import { MessageInjectionRequesterMismatchError } from "./message-injection-authority.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { ReplyToolAuthorityInput } from "./reply-tool-authority.types.js";

/** Keep execution settings with their owner while projecting current caller and policy facts. */
export function projectReplyToolAuthorityInput(
  snapshot: ReplyToolAuthorityInput,
  caller: ReplyToolAuthorityCaller | undefined,
  requesterPrincipalKey: string | undefined,
): ReplyToolAuthorityInput {
  const continuation = caller && "kind" in caller ? caller : undefined;
  const participant: ReplyToolAuthorityOverlay | ReplyToolAuthorityRequester | undefined =
    caller && "kind" in caller
      ? { ...caller.caller, traceAuthorized: snapshot.run.traceAuthorized === true }
      : caller;
  const incomingRequester =
    participant && !("requesterOrigin" in participant) && participant.allowCollaborativeSteering
      ? resolveRequesterPrincipalKey({
          ...participant,
          messageChannel: participant.originatingChannel,
        })
      : undefined;
  if (
    participant &&
    !("requesterOrigin" in participant) &&
    participant.allowCollaborativeSteering &&
    requesterPrincipalKey &&
    incomingRequester &&
    incomingRequester !== requesterPrincipalKey &&
    (!participant.inputProvenance || participant.inputProvenance.kind === "external_user") &&
    isSameReplyToolAuthorityConversation(snapshot, participant)
  ) {
    if (participant.operatorAuthority) {
      assertAdmittedRunOperatorAuthority(participant.operatorAuthority);
      participant.operatorAuthority.assertCurrent();
    }
    return snapshot;
  }
  const incoming = !participant
    ? snapshot
    : "requesterOrigin" in participant
      ? applyReplyToolAuthorityRequester(snapshot, participant)
      : continuation
        ? applyReplyToolAuthorityCaller(snapshot, participant)
        : applyReplyToolAuthorityOverlay(snapshot, participant);
  if (
    participant &&
    (!requesterPrincipalKey ||
      requesterPrincipalKey !==
        resolveRequesterPrincipalKey({
          ...incoming.run,
          messageChannel: incoming.originatingChannel,
          operatorAuthority: incoming.operatorAuthority,
        }))
  ) {
    throw new MessageInjectionRequesterMismatchError();
  }
  return continuation
    ? {
        ...incoming,
        run: {
          ...incoming.run,
          config: captureRuntimeConfig(continuation.config),
          // Trace output belongs to the executing turn, not its arriving caller.
          traceAuthorized: snapshot.run.traceAuthorized,
          // Discovery can retain available capabilities; it cannot add tools or destinations.
          clientCaps: (snapshot.run.clientCaps ?? []).every((cap) =>
            incoming.run.clientCaps?.includes(cap),
          )
            ? snapshot.run.clientCaps
            : incoming.run.clientCaps,
          gatewayUiCommandTarget: snapshot.run.gatewayUiCommandTarget
            ? incoming.run.gatewayUiCommandTarget
            : undefined,
        },
      }
    : incoming;
}

function applyReplyToolAuthorityRequester(
  snapshot: ReplyToolAuthorityInput,
  requester: ReplyToolAuthorityRequester,
): ReplyToolAuthorityInput {
  return {
    ...snapshot,
    run: {
      ...snapshot.run,
      config: captureRuntimeConfig(requester.config),
      requesterOrigin: captureRequesterOrigin(requester),
      // This is a fresh request, not the incumbent's external snapshot or completion.
      conversationToolPolicy: undefined,
      trustedInternalHandoff: undefined,
      inputProvenance: undefined,
      scheduledToolPolicy: undefined,
    },
  };
}

function applyReplyToolAuthorityOverlay(
  snapshot: ReplyToolAuthorityInput,
  overlay: ReplyToolAuthorityOverlay,
): ReplyToolAuthorityInput {
  const projected = applyReplyToolAuthorityCaller(snapshot, overlay);
  return {
    ...projected,
    run: {
      ...projected.run,
      conversationToolPolicy: overlay.conversationToolPolicy,
      inputProvenance: overlay.inputProvenance,
      trustedInternalHandoff: overlay.trustedInternalHandoff,
      scheduledToolPolicy: overlay.scheduledToolPolicy,
      runtimePluginToolGrant: overlay.runtimePluginToolGrant,
    },
  };
}

/** A joining caller revalidates permissions without replacing the execution's policy origin. */
function applyReplyToolAuthorityCaller(
  snapshot: ReplyToolAuthorityInput,
  overlay: ReplyToolAuthorityOverlay,
): ReplyToolAuthorityInput {
  return {
    ...snapshot,
    originatingChannel: overlay.originatingChannel,
    operatorAuthority: overlay.operatorAuthority,
    toolsAllow: overlay.toolsAllow,
    disableTools: overlay.disableTools,
    forceRestartSafeTools: overlay.forceRestartSafeTools,
    forceCodeModeTools: overlay.forceCodeModeTools,
    run: {
      ...snapshot.run,
      requesterOrigin: undefined,
      permissionMode: overlay.permissionMode,
      toolOverrides: overlay.toolOverrides,
      messageProvider: overlay.messageProvider,
      chatType: overlay.chatType,
      agentAccountId: overlay.agentAccountId,
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
      gitContributorProfileId: overlay.gitContributorProfileId,
      traceAuthorized: overlay.traceAuthorized,
      approvalReviewerDeviceId: overlay.approvalReviewerDeviceId,
      clientCaps: overlay.clientCaps,
      gatewayUiCommandTarget: overlay.gatewayUiCommandTarget,
      toolBindings: overlay.toolBindings,
    },
  };
}

/** Projects current inbound facts against the active run's frozen authority snapshot. */
export function resolveInboundReplyToolAuthorityOverlay(params: {
  ctx: RuntimeMsgContext;
  sessionEntry?: Pick<SessionEntry, "permissionMode" | "spawnedBy" | "toolOverrides">;
  senderIsOwner: boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  toolsAllow?: string[];
  disableTools: boolean;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
}): ReplyToolAuthorityOverlay {
  const { ctx } = params;
  const senderId = normalizeOptionalString(ctx.SenderId);
  const senderE164 = normalizeOptionalString(ctx.SenderE164);
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
    senderId:
      senderId ??
      (!senderE164 && shouldUseFromAsSenderFallback({ from: ctx.From, chatType: ctx.ChatType })
        ? normalizeOptionalString(ctx.From)
        : undefined),
    senderName: normalizeOptionalString(ctx.SenderName),
    senderUsername: normalizeOptionalString(ctx.SenderUsername),
    senderE164,
    senderIsOwner: params.senderIsOwner,
    gitContributorProfileId: getRequesterProfile(ctx)?.id ?? readSessionInputProfileId(ctx),
    inputProvenance: ctx.InputProvenance,
    trustedInternalHandoff: undefined,
    scheduledToolPolicy: undefined,
    runtimePluginToolGrant: undefined,
    toolsAllow: params.toolsAllow,
    disableTools: params.disableTools,
    forceRestartSafeTools: params.forceRestartSafeTools,
    forceCodeModeTools: params.forceCodeModeTools,
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

/** Session sharing alone does not establish that two inputs belong to the same conversation. */
function isSameReplyToolAuthorityConversation(
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
