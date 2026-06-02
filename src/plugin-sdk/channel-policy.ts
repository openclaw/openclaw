import {
  normalizeStringEntries,
  uniqueStrings,
} from "../../packages/normalization-core/src/string-normalization.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { createAllowlistProviderRestrictSendersWarningCollector } from "../channels/plugins/group-policy-warnings.js";
import type { ChannelSecurityAdapter } from "../channels/plugins/types.adapters.js";
import { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";
import type { GroupPolicy } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createScopedDmSecurityResolver } from "./channel-config-helpers.js";

export type {
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
} from "../config/types.tools.js";
export {
  composeAccountWarningCollectors,
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
  collectOpenGroupPolicyConfiguredRouteWarnings,
  collectOpenGroupPolicyRestrictSendersWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  collectOpenProviderGroupPolicyWarnings,
  projectAccountConfigWarningCollector,
  projectAccountWarningCollector,
  projectConfigAccountIdWarningCollector,
  projectConfigWarningCollector,
  projectWarningCollector,
} from "../channels/plugins/group-policy-warnings.js";
export { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
export {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  resolveToolsBySender,
  type ChannelGroupPolicy,
} from "../config/group-policy.js";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithCommandGate,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
  resolveOpenDmAllowlistAccess,
} from "./channel-access-compat.js";
export {
  evaluateGroupRouteAccessForPolicy,
  evaluateSenderGroupAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";
export { createAllowlistProviderRestrictSendersWarningCollector };

/** Normalizes allowFrom entries into trimmed unique string identifiers. */
export function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return normalizeStringEntries(list);
}

/** Coerces native feature settings to the supported boolean/auto shape. */
export function coerceNativeSetting(value: unknown): boolean | "auto" | undefined {
  if (value === true || value === false || value === "auto") {
    return value;
  }
  return undefined;
}

/** Candidate mutable allowlist path inspected for dangerous name-matching warnings. */
export type ChannelMutableAllowlistCandidate = {
  /** Human-readable config path shown in doctor output. */
  pathLabel: string;
  /** Raw allowlist value from config; non-arrays are ignored by the collector. */
  list: unknown;
};

type ChannelMutableAllowlistHit = {
  path: string;
  entry: string;
  dangerousFlagPath: string;
};

function collectMutableAllowlistWarningLines(
  hits: ChannelMutableAllowlistHit[],
  channel: string,
): string[] {
  if (hits.length === 0) {
    return [];
  }
  const exampleLines = hits
    .slice(0, 8)
    .map((hit) => `- ${sanitizeForLog(hit.path)}: ${sanitizeForLog(hit.entry)}`);
  // Keep doctor output actionable without dumping large allowlists or raw ANSI
  // sequences into logs.
  const remaining =
    hits.length > 8 ? `- +${hits.length - 8} more mutable allowlist entries.` : null;
  const flagPaths = uniqueStrings(hits.map((hit) => hit.dangerousFlagPath));
  const flagHint =
    flagPaths.length === 1
      ? sanitizeForLog(flagPaths[0] ?? "")
      : `${sanitizeForLog(flagPaths[0] ?? "")} (and ${flagPaths.length - 1} other scope flags)`;
  return [
    `- Found ${hits.length} mutable allowlist ${hits.length === 1 ? "entry" : "entries"} across ${channel} while name matching is disabled by default.`,
    ...exampleLines,
    ...(remaining ? [remaining] : []),
    `- Option A (break-glass): enable ${flagHint}=true to keep name/email/nick matching.`,
    "- Option B (recommended): resolve names/emails/nicks to stable sender IDs and rewrite the allowlist entries.",
  ];
}

/** Creates a warning collector for mutable name/email/nick allowlists when matching is disabled. */
export function createDangerousNameMatchingMutableAllowlistWarningCollector(params: {
  /** Channel config key used to find dangerous-name-matching scopes. */
  channel: string;
  /** Returns true when an allowlist entry depends on mutable names/emails/nicks. */
  detector: (entry: string) => boolean;
  /** Projects all mutable allowlist candidates for one account/config scope. */
  collectLists: (scope: {
    prefix: string;
    account: Record<string, unknown>;
    dangerousFlagPath: string;
  }) => ChannelMutableAllowlistCandidate[];
}) {
  return ({ cfg }: { cfg: OpenClawConfig }): string[] => {
    const hits: ChannelMutableAllowlistHit[] = [];
    for (const scope of collectProviderDangerousNameMatchingScopes(cfg, params.channel)) {
      if (scope.dangerousNameMatchingEnabled) {
        continue;
      }
      for (const candidate of params.collectLists(scope)) {
        if (!Array.isArray(candidate.list)) {
          continue;
        }
        // Only mutable human-readable identifiers are risky here; wildcard and
        // stable ids are handled by the normal allowlist policy path.
        for (const entry of candidate.list) {
          const text = String(entry).trim();
          if (!text || text === "*" || !params.detector(text)) {
            continue;
          }
          hits.push({
            path: candidate.pathLabel,
            entry: text,
            dangerousFlagPath: scope.dangerousFlagPath,
          });
        }
      }
    }
    return collectMutableAllowlistWarningLines(hits, params.channel);
  };
}

/** Compose the common DM policy resolver with restrict-senders group warnings. */
export function createRestrictSendersChannelSecurity<
  ResolvedAccount extends { accountId?: string | null },
>(params: {
  /** Channel config key used for shared defaults and account lookups. */
  channelKey: string;
  /** Resolves the DM policy value from a channel account. */
  resolveDmPolicy: (account: ResolvedAccount) => string | null | undefined;
  /** Resolves account-local DM allowlist entries before shared fallback handling. */
  resolveDmAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  /** Resolves group policy for restrict-senders warning collection. */
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  /** User-facing channel/plugin name shown in warning text. */
  surface: string;
  /** Config scope considered open enough to require restrict-senders warnings. */
  openScope: string;
  /** Config path shown for the group policy value. */
  groupPolicyPath: string;
  /** Config path shown for the group sender allowlist value. */
  groupAllowFromPath: string;
  /** Whether group access is additionally gated on mentions. */
  mentionGated?: boolean;
  /** Returns true when provider/channel config exists and warnings should run. */
  providerConfigPresent?: (cfg: OpenClawConfig) => boolean;
  /** Resolves the account id used when account.accountId is absent. */
  resolveFallbackAccountId?: (account: ResolvedAccount) => string | null | undefined;
  /** Default DM policy when account config omits one. */
  defaultDmPolicy?: string;
  /** Config path suffix for account-local DM allowlists. */
  allowFromPathSuffix?: string;
  /** Config path suffix for account-local DM policy values. */
  policyPathSuffix?: string;
  /** Approval channel id used when DM policy allows approval fallback. */
  approveChannelId?: string;
  /** Optional hint shown beside approval fallback guidance. */
  approveHint?: string;
  /** Normalizes raw allowlist entries before DM policy matching. */
  normalizeDmEntry?: (raw: string) => string;
  /** Reuses default-account shared policy defaults for account-specific config. */
  inheritSharedDefaultsFromDefaultAccount?: boolean;
}): ChannelSecurityAdapter<ResolvedAccount> {
  return {
    // One descriptor builds both DM allowlist enforcement and group warning
    // collection so channel plugins do not drift between runtime and doctor policy.
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
      inheritSharedDefaultsFromDefaultAccount: params.inheritSharedDefaultsFromDefaultAccount,
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
