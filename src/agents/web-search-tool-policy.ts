import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "./agent-tools.policy.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import {
  resolveRouteBoundSenderToolPolicyIdentity,
  resolveSenderToolPolicy,
} from "./sender-tool-policy.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "./subagent-capabilities.js";
import { isToolAllowedByPolicies } from "./tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "./tool-policy.js";

export type WebSearchToolPolicyParams = {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  sandboxToolPolicy?: SandboxToolPolicy;
  messageProvider?: string;
  agentAccountId?: string | null;
  senderMessageProvider?: string | null;
  senderAccountId?: string | null;
  requireSenderRouteBinding?: boolean;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

type WebSearchToolPolicyResolution = {
  allowed: boolean;
  persistentAllowed: boolean;
};

/** Resolves current and sender-independent policy for the managed web_search tool. */
export function resolveWebSearchToolPolicy(
  params: WebSearchToolPolicyParams,
): WebSearchToolPolicyResolution {
  const senderPolicyIdentity = resolveRouteBoundSenderToolPolicyIdentity({
    routeMessageProvider: params.messageProvider,
    routeAccountId: params.agentAccountId,
    senderMessageProvider:
      params.senderMessageProvider === undefined
        ? params.messageProvider
        : params.senderMessageProvider,
    senderAccountId:
      params.senderAccountId === undefined ? params.agentAccountId : params.senderAccountId,
    requireRouteBinding: params.requireSenderRouteBinding,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow);
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(providerProfile),
    providerProfileAlsoAllow,
  );
  const groupPolicyParams = {
    config: params.config,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.agentAccountId,
  };
  const groupPolicy = resolveGroupToolPolicy({
    ...groupPolicyParams,
    senderMessageProvider: senderPolicyIdentity.messageProvider,
    senderId: senderPolicyIdentity.senderId,
    senderName: senderPolicyIdentity.senderName,
    senderUsername: senderPolicyIdentity.senderUsername,
    senderE164: senderPolicyIdentity.senderE164,
  });
  const persistentGroupPolicy = resolveGroupToolPolicy(groupPolicyParams);
  const senderPolicyParams = {
    config: params.config,
    agentId,
    messageProvider: params.messageProvider,
  };
  const senderPolicy = senderPolicyIdentity.routeBound
    ? resolveSenderToolPolicy({
        ...senderPolicyParams,
        messageProvider: senderPolicyIdentity.messageProvider,
        senderId: senderPolicyIdentity.senderId,
        senderName: senderPolicyIdentity.senderName,
        senderUsername: senderPolicyIdentity.senderUsername,
        senderE164: senderPolicyIdentity.senderE164,
      })
    : { deny: ["*"] };
  const persistentSenderPolicy = resolveSenderToolPolicy(senderPolicyParams);
  const subagentStore = resolveSubagentCapabilityStore(params.sessionKey, {
    cfg: params.config,
  });
  const subagentPolicy =
    params.sessionKey &&
    isSubagentEnvelopeSession(params.sessionKey, {
      cfg: params.config,
      store: subagentStore,
    })
      ? resolveSubagentToolPolicyForSession(params.config, params.sessionKey, {
          store: subagentStore,
        })
      : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(
    params.config,
    params.sessionKey,
    {
      store: subagentStore,
    },
  );
  const fixedPolicies = [
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
  ];
  const trailingPolicies = [params.sandboxToolPolicy, subagentPolicy, inheritedToolPolicy];
  return {
    allowed: isToolAllowedByPolicies("web_search", [
      ...fixedPolicies,
      groupPolicy,
      senderPolicy,
      ...trailingPolicies,
    ]),
    persistentAllowed: isToolAllowedByPolicies("web_search", [
      ...fixedPolicies,
      persistentGroupPolicy,
      persistentSenderPolicy,
      ...trailingPolicies,
    ]),
  };
}
