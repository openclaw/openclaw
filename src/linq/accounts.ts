import type { OpenClawConfig } from "../config/config.js";
import type { LinqAccountConfig } from "../config/types.linq.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

export type ResolvedLinqAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: LinqAccountConfig;
  configured: boolean;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const linq = cfg.channels?.linq as LinqAccountConfig & { accounts?: Record<string, unknown> } | undefined;
  const accounts = linq?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listLinqAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultLinqAccountId(cfg: OpenClawConfig): string {
  const ids = listLinqAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): LinqAccountConfig | undefined {
  const linq = cfg.channels?.linq as LinqAccountConfig & { accounts?: Record<string, LinqAccountConfig> } | undefined;
  const accounts = linq?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as LinqAccountConfig | undefined;
}

function mergeLinqAccountConfig(cfg: OpenClawConfig, accountId: string): LinqAccountConfig {
  const linq = (cfg.channels?.linq ?? {}) as LinqAccountConfig & { accounts?: unknown };
  const { accounts: _ignored, ...base } = linq;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveLinqAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedLinqAccount {
  const accountId = normalizeAccountId(params.accountId);
  const linq = params.cfg.channels?.linq as LinqAccountConfig | undefined;
  const baseEnabled = linq?.enabled !== false;
  const merged = mergeLinqAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const configured = Boolean(
    merged.apiToken?.trim() ||
    merged.tokenFile?.trim() ||
    merged.fromNumber?.trim() ||
    (merged.allowFrom && merged.allowFrom.length > 0) ||
    (merged.groupAllowFrom && merged.groupAllowFrom.length > 0) ||
    merged.dmPolicy ||
    merged.groupPolicy ||
    typeof merged.mediaMaxMb === "number" ||
    typeof merged.textChunkLimit === "number" ||
    (merged.groups && Object.keys(merged.groups).length > 0),
  );
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    config: merged,
    configured,
  };
}

export function listEnabledLinqAccounts(cfg: OpenClawConfig): ResolvedLinqAccount[] {
  return listLinqAccountIds(cfg)
    .map((accountId) => resolveLinqAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
