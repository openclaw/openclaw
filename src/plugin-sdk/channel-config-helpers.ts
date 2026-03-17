import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
import {
  collectAllowlistProviderGroupPolicyWarnings,
  collectAllowlistProviderRestrictSendersWarnings,
  collectOpenGroupPolicyConfiguredRouteWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  collectOpenProviderGroupPolicyWarnings,
} from "../channels/plugins/group-policy-warnings.js";
import { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
import { normalizeWhatsAppAllowFromEntries } from "../channels/plugins/normalize/whatsapp.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { ChannelConfigAdapter } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";

/** Coerce mixed allowlist config values into plain strings without trimming or deduping. */
export function mapAllowFromEntries(
  allowFrom: Array<string | number> | null | undefined,
): string[] {
  return (allowFrom ?? []).map((entry) => String(entry));
}

/** Normalize user-facing allowlist entries the same way config and doctor flows expect. */
export function formatTrimmedAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return normalizeStringEntries(allowFrom);
}

/** Collapse nullable config scalars into a trimmed optional string. */
export function resolveOptionalConfigString(
  value: string | number | null | undefined,
): string | undefined {
  if (value == null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

/** Build the shared allowlist/default target adapter surface for account-scoped channel configs. */
export function createScopedAccountConfigAccessors<ResolvedAccount>(params: {
  resolveAccount: (params: { cfg: OpenClawConfig; accountId?: string | null }) => ResolvedAccount;
  resolveAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  formatAllowFrom: (allowFrom: Array<string | number>) => string[];
  resolveDefaultTo?: (account: ResolvedAccount) => string | number | null | undefined;
}): Pick<
  ChannelConfigAdapter<ResolvedAccount>,
  "resolveAllowFrom" | "formatAllowFrom" | "resolveDefaultTo"
> {
  const base = {
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
      mapAllowFromEntries(params.resolveAllowFrom(params.resolveAccount({ cfg, accountId }))),
    formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
      params.formatAllowFrom(allowFrom),
  };

  if (!params.resolveDefaultTo) {
    return base;
  }

  return {
    ...base,
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveOptionalConfigString(
        params.resolveDefaultTo?.(params.resolveAccount({ cfg, accountId })),
      ),
  };
}

/** Build the common CRUD/config helpers for channels that store multiple named accounts. */
export function createScopedChannelConfigBase<
  ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(params: {
  sectionKey: string;
  listAccountIds: (cfg: Config) => string[];
  resolveAccount: (cfg: Config, accountId?: string | null) => ResolvedAccount;
  defaultAccountId: (cfg: Config) => string;
  inspectAccount?: (cfg: Config, accountId?: string | null) => unknown;
  clearBaseFields: string[];
  allowTopLevel?: boolean;
}): Pick<
  ChannelConfigAdapter<ResolvedAccount>,
  | "listAccountIds"
  | "resolveAccount"
  | "inspectAccount"
  | "defaultAccountId"
  | "setAccountEnabled"
  | "deleteAccount"
> {
  return {
    listAccountIds: (cfg) => params.listAccountIds(cfg as Config),
    resolveAccount: (cfg, accountId) => params.resolveAccount(cfg as Config, accountId),
    inspectAccount: params.inspectAccount
      ? (cfg, accountId) => params.inspectAccount?.(cfg as Config, accountId)
      : undefined,
    defaultAccountId: (cfg) => params.defaultAccountId(cfg as Config),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as Config,
        sectionKey: params.sectionKey,
        accountId,
        enabled,
        allowTopLevel: params.allowTopLevel ?? true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as Config,
        sectionKey: params.sectionKey,
        accountId,
        clearBaseFields: params.clearBaseFields,
      }),
  };
}

/** Convert account-specific DM security fields into the shared runtime policy resolver shape. */
export function createScopedDmSecurityResolver<
  ResolvedAccount extends { accountId?: string | null },
>(params: {
  channelKey: string;
  resolvePolicy: (account: ResolvedAccount) => string | null | undefined;
  resolveAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  resolveFallbackAccountId?: (account: ResolvedAccount) => string | null | undefined;
  defaultPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeEntry?: (raw: string) => string;
}) {
  return ({
    cfg,
    accountId,
    account,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    account: ResolvedAccount;
  }) =>
    buildAccountScopedDmSecurityPolicy({
      cfg,
      channelKey: params.channelKey,
      accountId,
      fallbackAccountId: params.resolveFallbackAccountId?.(account) ?? account.accountId,
      policy: params.resolvePolicy(account),
      allowFrom: params.resolveAllowFrom(account) ?? [],
      defaultPolicy: params.defaultPolicy,
      allowFromPathSuffix: params.allowFromPathSuffix,
      policyPathSuffix: params.policyPathSuffix,
      approveChannelId: params.approveChannelId,
      approveHint: params.approveHint,
      normalizeEntry: params.normalizeEntry,
    });
}

export { buildAccountScopedDmSecurityPolicy };
export {
  collectAllowlistProviderGroupPolicyWarnings,
  collectAllowlistProviderRestrictSendersWarnings,
  collectOpenGroupPolicyConfiguredRouteWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  collectOpenProviderGroupPolicyWarnings,
};

/** Read the effective WhatsApp allowlist through the active plugin contract. */
export function resolveWhatsAppConfigAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = getChannelPlugin("whatsapp")?.config.resolveAccount(params.cfg, params.accountId);
  return account && typeof account === "object" && Array.isArray(account.allowFrom)
    ? account.allowFrom.map(String)
    : [];
}

/** Format WhatsApp allowlist entries with the same normalization used by the channel plugin. */
export function formatWhatsAppConfigAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return normalizeWhatsAppAllowFromEntries(allowFrom);
}

/** Resolve the effective WhatsApp default recipient after account and root config fallback. */
export function resolveWhatsAppConfigDefaultTo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string | undefined {
  const root = params.cfg.channels?.whatsapp;
  const normalized = normalizeAccountId(params.accountId);
  const account = root?.accounts?.[normalized];
  return (account?.defaultTo ?? root?.defaultTo)?.trim() || undefined;
}

/** Read iMessage allowlist entries from the active plugin's resolved account view. */
export function resolveIMessageConfigAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = getChannelPlugin("imessage")?.config.resolveAccount(params.cfg, params.accountId);
  if (!account || typeof account !== "object" || !("config" in account)) {
    return [];
  }
  return mapAllowFromEntries(account.config.allowFrom);
}

/** Resolve the effective iMessage default recipient from the plugin-resolved account config. */
export function resolveIMessageConfigDefaultTo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string | undefined {
  const account = getChannelPlugin("imessage")?.config.resolveAccount(params.cfg, params.accountId);
  if (!account || typeof account !== "object" || !("config" in account)) {
    return undefined;
  }
  return resolveOptionalConfigString(account.config.defaultTo);
}
