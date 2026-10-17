import { resolveEffectiveToolPolicy, resolveGroupToolPolicy } from "./agent-tools.policy.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";
import { resolveScheduledToolCallerContext } from "./scheduled-tool-policy.js";
import { resolveSenderToolPolicy } from "./sender-tool-policy.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicies } from "./tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "./tool-policy.js";
import type {
  WebSearchToolPolicyParams,
  WebSearchToolPolicyResolution,
} from "./web-search-tool-policy.types.js";

export type { WebSearchToolPolicyParams } from "./web-search-tool-policy.types.js";

/** Resolves current and sender-independent policy for the managed web_search tool. */
export function resolveWebSearchToolPolicy(
  params: WebSearchToolPolicyParams,
): WebSearchToolPolicyResolution {
  if (params.webSearchEnabled === false) {
    return { allowed: false, persistentAllowed: false };
  }
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
  const callerContext = resolveScheduledToolCallerContext({
    scheduledToolPolicy: params.scheduledToolPolicy,
    channel: params.messageProvider,
  });
  const groupPolicyParams = {
    config: params.config,
    sessionKey: params.scheduledToolPolicy?.ownerSessionKey ?? params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: callerContext.local
      ? params.messageProvider
      : (callerContext.channel ?? undefined),
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.scheduledToolPolicy?.ownerAccountId ?? params.agentAccountId,
    requireConfiguredAccount: params.scheduledToolPolicy?.mode === "account",
    senderPolicyMode: params.scheduledToolPolicy ? ("never" as const) : ("always" as const),
  };
  const senderPolicyParams = {
    config: params.config,
    agentId,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
  };
  const requesterPolicies =
    params.preparedRequesterPolicy ??
    resolveRequesterToolPolicies({
      ...groupPolicyParams,
      agentId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      inputProvenance: params.inputProvenance,
      trustedInternalHandoff: params.trustedInternalHandoff,
      sessionId: params.sessionId,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
      groupPolicySessionKey: params.scheduledToolPolicy?.ownerSessionKey,
      requireConfiguredGroupAccount: params.scheduledToolPolicy?.mode === "account",
    });
  const persistentGroupPolicy = requesterPolicies.delegated
    ? undefined
    : resolveGroupToolPolicy(groupPolicyParams);
  const persistentSenderPolicy =
    requesterPolicies.delegated || params.scheduledToolPolicy
      ? undefined
      : resolveSenderToolPolicy(senderPolicyParams);
  const fixedPolicies = [
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
  ];
  const trailingPolicies = [
    params.sandboxToolPolicy,
    requesterPolicies.subagentPolicy,
    requesterPolicies.inheritedToolPolicy,
  ];
  return {
    // Runtime caps apply only to this turn; persistent policy keeps provider sessions reusable.
    allowed:
      isRuntimeToolAllowed("web_search", params.runtimeToolAllowlist) &&
      isToolAllowedByPolicies("web_search", [
        ...fixedPolicies,
        requesterPolicies.groupPolicy,
        requesterPolicies.senderPolicy,
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
