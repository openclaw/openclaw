import { createAllowlistProviderRestrictSendersWarningCollector } from "../channels/plugins/group-policy-warnings.js";
import type { ChannelSecurityAdapter } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import type { GroupPolicy } from "../config/types.base.js";
import { createScopedDmSecurityResolver } from "./channel-config-helpers.js";
/** Shared policy warnings and DM/group policy helpers for channel plugins. */
export type {
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
} from "../config/types.tools.js";
export {
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
  composeWarningCollectors,
  createAllowlistProviderGroupPolicyWarningCollector,
  createConditionalWarningCollector,
  createAllowlistProviderOpenWarningCollector,
  createAllowlistProviderRouteAllowlistWarningCollector,
  createOpenGroupPolicyRestrictSendersWarningCollector,
  createOpenProviderGroupPolicyWarningCollector,
  createOpenProviderConfiguredRouteWarningCollector,
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
  collectAllowlistProviderGroupPolicyWarnings,
  collectAllowlistProviderRestrictSendersWarnings,
  collectOpenGroupPolicyRestrictSendersWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  collectOpenProviderGroupPolicyWarnings,
  projectWarningCollector,
} from "../channels/plugins/group-policy-warnings.js";
export { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
export {
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  resolveToolsBySender,
} from "../config/group-policy.js";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "../security/dm-policy-shared.js";
export { createAllowlistProviderRestrictSendersWarningCollector };

/** Compose the common DM policy resolver with restrict-senders group warnings. */
export function createRestrictSendersChannelSecurity<
  ResolvedAccount extends { accountId?: string | null },
>(params: {
  channelKey: string;
  resolveDmPolicy: (account: ResolvedAccount) => string | null | undefined;
  resolveDmAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
  providerConfigPresent?: (cfg: OpenClawConfig) => boolean;
  resolveFallbackAccountId?: (account: ResolvedAccount) => string | null | undefined;
  defaultDmPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeDmEntry?: (raw: string) => string;
}): ChannelSecurityAdapter<ResolvedAccount> {
  return {
    resolveDmPolicy: createScopedDmSecurityResolver<ResolvedAccount>({
      channelKey: params.channelKey,
      resolvePolicy: params.resolveDmPolicy,
      resolveAllowFrom: params.resolveDmAllowFrom,
      resolveFallbackAccountId: params.resolveFallbackAccountId,
      defaultPolicy: params.defaultDmPolicy,
      allowFromPathSuffix: params.allowFromPathSuffix,
      policyPathSuffix: params.policyPathSuffix,
      approveChannelId: params.approveChannelId,
      approveHint: params.approveHint,
      normalizeEntry: params.normalizeDmEntry,
    }),
    collectWarnings: createAllowlistProviderRestrictSendersWarningCollector<ResolvedAccount>({
      providerConfigPresent:
        params.providerConfigPresent ?? ((cfg) => cfg.channels?.[params.channelKey] !== undefined),
      resolveGroupPolicy: params.resolveGroupPolicy,
      surface: params.surface,
      openScope: params.openScope,
      groupPolicyPath: params.groupPolicyPath,
      groupAllowFromPath: params.groupAllowFromPath,
      mentionGated: params.mentionGated,
    }),
  };
}
