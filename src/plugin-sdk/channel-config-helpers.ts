import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
import { normalizeWhatsAppAllowFromEntries } from "../channels/plugins/normalize/whatsapp.js";
import type { ChannelConfigAdapter } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveIMessageAccount } from "../imessage/accounts.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";

export function mapAllowFromEntries(
  allowFrom: Array<string | number> | null | undefined,
): string[] {
  return (allowFrom ?? []).map((entry) => String(entry));
}

export function formatTrimmedAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return normalizeStringEntries(allowFrom);
}

export function resolveOptionalConfigString(
  value: string | number | null | undefined,
): string | undefined {
  if (value == null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

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

export function resolveWhatsAppConfigAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return resolveWhatsAppAccount(params).allowFrom ?? [];
}

export function formatWhatsAppConfigAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return normalizeWhatsAppAllowFromEntries(allowFrom);
}

export function resolveWhatsAppConfigDefaultTo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string | undefined {
  const root = params.cfg.channels?.whatsapp;
  const normalized = normalizeAccountId(params.accountId);
  const account = root?.accounts?.[normalized];
  return (account?.defaultTo ?? root?.defaultTo)?.trim() || undefined;
}

export function resolveIMessageConfigAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return mapAllowFromEntries(resolveIMessageAccount(params).config.allowFrom);
}

export function resolveIMessageConfigDefaultTo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string | undefined {
  return resolveOptionalConfigString(resolveIMessageAccount(params).config.defaultTo);
}
