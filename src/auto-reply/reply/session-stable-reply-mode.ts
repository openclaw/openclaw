import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../../agents/agent-tools.policy.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../agents/subagents/spawn/subagent-capabilities.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import { resolveVisibleRepliesPolicy } from "./dispatch-from-config.harness-defaults.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode.js";

/** Synthetic and chat turns must share messageToolPolicyHash to reuse CLI sessions (#121485). */
export function resolveSessionStableReplyMode(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  sessionEntry: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  turnModelOverride?: string;
}): SourceReplyDeliveryMode {
  const { cfg, ctx, sessionEntry } = params;
  const chatType =
    normalizeChatType(ctx.ChatType) ?? normalizeChatType(sessionEntry.chatType) ?? undefined;
  // A targetless internal turn uses the session's established reply policy;
  // changing that policy on a wake would invalidate its reusable CLI binding.
  const stableReplyContext = {
    CommandAuthorized: false,
    ChatType: chatType,
    Provider:
      normalizeOptionalString(ctx.Provider) ??
      sessionDeliveryOrigin(sessionEntry)?.provider ??
      INTERNAL_MESSAGE_CHANNEL,
    Surface: normalizeOptionalString(ctx.Surface) ?? sessionDeliveryChannel(sessionEntry),
    ExplicitDeliverRoute: ctx.ExplicitDeliverRoute,
  };
  const { harnessDefaultVisibleReplies } = resolveVisibleRepliesPolicy({
    cfg,
    chatType,
    ctx,
    entry: sessionEntry,
    sessionAgentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    sessionStore: params.sessionStore,
    turnModelOverride: params.turnModelOverride,
  });
  const candidateMode = resolveSourceReplyDeliveryMode({
    cfg,
    ctx: stableReplyContext,
    defaultVisibleReplies: harnessDefaultVisibleReplies,
  });
  if (candidateMode !== "message_tool_only") {
    return candidateMode;
  }
  // Match dispatch's availability downgrade without letting sender-specific
  // permissions change the policy shared by all turns in this session.
  return resolveStableMessageToolAvailability(params) ? candidateMode : "automatic";
}

/** Shared by dispatch and synthetic turns; sender denials apply only to the individual turn. */
export function resolveStableMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  sessionEntry?: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
}): boolean {
  const { cfg, ctx, sessionEntry } = params;
  // Bare command/wake contexts need the same persisted group/account facts as live dispatch.
  const groupPolicy = resolveGroupToolPolicy({
    config: cfg,
    sessionKey: params.sessionKey,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel:
        ctx.OriginatingChannel ?? (sessionEntry ? sessionDeliveryChannel(sessionEntry) : undefined),
      provider:
        normalizeOptionalString(ctx.Provider ?? ctx.Surface) ??
        (sessionEntry ? sessionDeliveryOrigin(sessionEntry)?.provider : undefined),
    }),
    groupId: resolveGroupSessionKey(ctx)?.id ?? sessionEntry?.groupId,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ??
      normalizeOptionalString(ctx.GroupSubject) ??
      normalizeOptionalString(sessionEntry?.groupChannel) ??
      normalizeOptionalString(sessionEntry?.subject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    accountId:
      ctx.AccountId ??
      (sessionEntry ? deliveryContextFromSession(sessionEntry)?.accountId : undefined),
  });
  return resolveMessageToolAvailability({
    ...params,
    groupPolicy,
    prefersMessageToolDelivery: true,
  });
}

/** Applies the same profile, account, group, and delegation layers to every reply turn. */
export function resolveMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  sessionAgentId: string;
  sessionKey?: string;
  groupPolicy: ReturnType<typeof resolveGroupToolPolicy>;
  prefersMessageToolDelivery: boolean;
}): boolean {
  const { cfg, groupPolicy } = params;
  const {
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: cfg,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
  });
  const profileAlsoAllowed = params.prefersMessageToolDelivery ? ["message"] : [];
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), [
    ...(profileAlsoAllow ?? []),
    ...profileAlsoAllowed,
  ]);
  const providerProfilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(providerProfile), [
    ...(providerProfileAlsoAllow ?? []),
    ...profileAlsoAllowed,
  ]);
  const subagentStore = resolveSubagentCapabilityStore(params.sessionKey, { cfg });
  const subagentPolicy =
    params.sessionKey && isSubagentEnvelopeSession(params.sessionKey, { cfg, store: subagentStore })
      ? resolveSubagentToolPolicyForSession(cfg, params.sessionKey, { store: subagentStore })
      : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(cfg, params.sessionKey, {
    store: subagentStore,
  });
  return isToolAllowedByPolicies("message", [
    profilePolicy,
    providerProfilePolicy,
    globalProviderPolicy,
    agentProviderPolicy,
    globalPolicy,
    agentPolicy,
    groupPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  ]);
}
