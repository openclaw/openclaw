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
} from "../../agents/subagent-capabilities.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedMsgContext } from "../templating.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";

export function resolveSourceReplyMessageToolAvailable(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  sessionAgentId: string;
  sessionKey?: string;
  prefersMessageToolDelivery: boolean;
}): boolean {
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
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
  });
  const runtimeProfileAlsoAllow = params.prefersMessageToolDelivery ? ["message"] : [];
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), [
    ...(profileAlsoAllow ?? []),
    ...runtimeProfileAlsoAllow,
  ]);
  const providerProfilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(providerProfile), [
    ...(providerProfileAlsoAllow ?? []),
    ...runtimeProfileAlsoAllow,
  ]);
  const groupResolution = resolveGroupSessionKey(params.ctx);
  const messageProvider = resolveOriginMessageProvider({
    originatingChannel: params.ctx.OriginatingChannel,
    provider: params.ctx.Provider ?? params.ctx.Surface,
  });
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider,
    groupId: groupResolution?.id,
    groupChannel:
      normalizeOptionalString(params.ctx.GroupChannel) ??
      normalizeOptionalString(params.ctx.GroupSubject),
    groupSpace: normalizeOptionalString(params.ctx.GroupSpace),
    accountId: params.ctx.AccountId,
    senderId: normalizeOptionalString(params.ctx.SenderId),
    senderName: normalizeOptionalString(params.ctx.SenderName),
    senderUsername: normalizeOptionalString(params.ctx.SenderUsername),
    senderE164: normalizeOptionalString(params.ctx.SenderE164),
  });
  const subagentStore = resolveSubagentCapabilityStore(params.sessionKey, { cfg: params.cfg });
  const subagentPolicy =
    params.sessionKey &&
    isSubagentEnvelopeSession(params.sessionKey, {
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
