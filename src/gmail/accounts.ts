import type { OpenClawConfig } from "../config/config.js";
import type { GmailAccountConfig, GmailActionConfig } from "./types.js";
import { resolveGmailRefreshToken } from "./token.js";

const DEFAULT_ACCOUNT_ID = "default";

export type ResolvedGmailAccount = {
  accountId: string;
  enabled: boolean;
  refreshToken?: string;
  config: GmailAccountConfig;
  actions?: GmailActionConfig;
};

function getGmailConfig(cfg: OpenClawConfig) {
  return (cfg.channels as Record<string, unknown> | undefined)?.gmail as
    | (GmailAccountConfig & { accounts?: Record<string, GmailAccountConfig> })
    | undefined;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const gmail = getGmailConfig(cfg);
  const accounts = gmail?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listGmailAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): GmailAccountConfig | undefined {
  const gmail = getGmailConfig(cfg);
  const accounts = gmail?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeGmailAccountConfig(cfg: OpenClawConfig, accountId: string): GmailAccountConfig {
  const gmail = getGmailConfig(cfg);
  const { accounts: _ignored, ...base } = (gmail ?? {}) as GmailAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveGmailAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedGmailAccount {
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const gmail = getGmailConfig(params.cfg);
  const baseEnabled = gmail?.enabled !== false;
  const merged = mergeGmailAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? resolveGmailRefreshToken(process.env.GMAIL_REFRESH_TOKEN) : undefined;
  const configToken = resolveGmailRefreshToken(merged.refreshToken);
  const refreshToken = configToken ?? envToken;

  return {
    accountId,
    enabled,
    refreshToken,
    config: merged,
    actions: merged.actions,
  };
}

export function listEnabledGmailAccounts(cfg: OpenClawConfig): ResolvedGmailAccount[] {
  return listGmailAccountIds(cfg)
    .map((accountId) => resolveGmailAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
