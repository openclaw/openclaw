import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  bindReplyInputChannel,
  isSharedGatewayOwnerRunAuthority,
  readReplyInputChannel,
} from "../../agents/harness/host-private-capabilities.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { bindCommandOwnerAuthority, getCommandOwnerAuthority } from "../command-owner-authority.js";
import {
  getRequesterProfile,
  readTransferredRequesterProfile,
  transferRequesterProfile,
} from "../requester-profile.js";
import type { RuntimeMsgContext } from "../templating.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { ReplyToolAuthorityOverlay } from "./reply-run-registry.contracts.js";
import type { ReplyToolAuthorityInput } from "./reply-tool-authority.types.js";

export type AuthorizedCrossSurfaceContinuation = {
  kind: "verified-profile" | "shared-owner";
  allowPendingUserInputAnswer: false;
  assertCurrent: () => void;
};

const authorizedCrossSurfaceContinuations = new WeakMap<
  object,
  AuthorizedCrossSurfaceContinuation
>();

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
      permissionMode: overlay.permissionMode,
      toolOverrides: overlay.toolOverrides,
      messageProvider: overlay.messageProvider,
      chatType: overlay.chatType,
      agentAccountId: overlay.agentAccountId,
      conversationToolPolicy: overlay.conversationToolPolicy,
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

export function readAuthorizedCrossSurfaceContinuation(
  caller: object,
): AuthorizedCrossSurfaceContinuation | undefined {
  const continuation = authorizedCrossSurfaceContinuations.get(caller);
  continuation?.assertCurrent();
  return continuation;
}

export function resolveAuthorizedCrossSurfaceContinuation(params: {
  incumbent: object;
  snapshot: ReplyToolAuthorityInput;
  caller: ReplyToolAuthorityOverlay;
}): AuthorizedCrossSurfaceContinuation | undefined {
  const { caller, snapshot } = params;
  if (
    !caller.sessionKey?.trim() ||
    caller.sessionKey.trim() !== snapshot.run.sessionKey?.trim() ||
    (caller.inputProvenance && caller.inputProvenance.kind !== "external_user") ||
    (snapshot.run.inputProvenance && snapshot.run.inputProvenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const incumbentProfile = readTransferredRequesterProfile(params.incumbent);
  const incomingProfile = readTransferredRequesterProfile(caller);
  const incumbentChannel = readReplyInputChannel(snapshot.run);
  const incomingChannel = readReplyInputChannel(caller);
  if (
    incumbentChannel &&
    incomingChannel &&
    incumbentProfile &&
    incomingProfile &&
    incumbentProfile.id !== GATEWAY_OWNER_PROFILE_ID &&
    incumbentProfile.id === incomingProfile.id
  ) {
    const continuation: AuthorizedCrossSurfaceContinuation = {
      kind: "verified-profile",
      allowPendingUserInputAnswer: false,
      assertCurrent: () => {
        if (!incumbentProfile.isCurrent() || !incomingProfile.isCurrent()) {
          throw new Error("Requester profile binding is no longer current");
        }
      },
    };
    authorizedCrossSurfaceContinuations.set(caller, continuation);
    return continuation;
  }
  const incumbentShared = isSharedGatewayOwnerRunAuthority(snapshot.operatorAuthority);
  const incomingShared = isSharedGatewayOwnerRunAuthority(caller.operatorAuthority);
  if (incumbentShared === incomingShared) {
    return undefined;
  }
  const channel = incumbentShared ? incomingChannel : incumbentChannel;
  if (!channel) {
    return undefined;
  }
  const shared = incumbentShared ? snapshot.operatorAuthority : caller.operatorAuthority;
  const owner = incumbentShared
    ? getCommandOwnerAuthority(caller)
    : getCommandOwnerAuthority(snapshot.run);
  if (
    caller.allowCollaborativeSteering !== true &&
    (!shared?.scopes.includes("operator.admin") || owner?.isCurrent() !== true)
  ) {
    return undefined;
  }
  const continuation: AuthorizedCrossSurfaceContinuation = {
    kind: "shared-owner",
    allowPendingUserInputAnswer: false,
    assertCurrent: () => {
      shared?.assertCurrent();
      if (caller.allowCollaborativeSteering !== true && owner?.isCurrent() !== true) {
        throw new Error("Channel owner authority is no longer current");
      }
    },
  };
  authorizedCrossSurfaceContinuations.set(caller, continuation);
  return continuation;
}

/** Projects current inbound facts against the active run's frozen authority snapshot. */
export function resolveInboundReplyToolAuthorityOverlay(params: {
  ctx: RuntimeMsgContext;
  sessionEntry?: Pick<SessionEntry, "permissionMode" | "spawnedBy" | "toolOverrides">;
  senderIsOwner: boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  toolsAllow?: string[];
  disableTools: boolean;
  allowCollaborativeSteering?: boolean;
}): ReplyToolAuthorityOverlay {
  const { ctx } = params;
  const overlay: ReplyToolAuthorityOverlay = {
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
    gitContributorProfileId: getRequesterProfile(ctx)?.id,
    inputProvenance: ctx.InputProvenance,
    allowCollaborativeSteering: params.allowCollaborativeSteering,
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
  transferRequesterProfile(ctx, overlay);
  bindReplyInputChannel(overlay, ctx.SenderIsBot ? undefined : (ctx.Provider ?? ctx.Surface));
  const ownerAuthority = getCommandOwnerAuthority(ctx);
  if (ownerAuthority) {
    bindCommandOwnerAuthority(overlay, ownerAuthority);
  }
  return overlay;
}
