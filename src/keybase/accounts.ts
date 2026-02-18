import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { KeybaseAccountConfig } from "../config/types.js";
import { normalizeAccountId } from "../routing/session-key.js";

export type ResolvedKeybaseAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  config: KeybaseAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("keybase");
export const listKeybaseAccountIds = listAccountIds;
export const resolveDefaultKeybaseAccountId = resolveDefaultAccountId;

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): KeybaseAccountConfig | undefined {
  const accounts = (cfg.channels as Record<string, unknown> | undefined)?.keybase as
    | (KeybaseAccountConfig & { accounts?: Record<string, KeybaseAccountConfig> })
    | undefined;
  if (!accounts?.accounts || typeof accounts.accounts !== "object") {
    return undefined;
  }
  return accounts.accounts[accountId] as KeybaseAccountConfig | undefined;
}

function getKeybaseChannelConfig(
  cfg: OpenClawConfig,
): (KeybaseAccountConfig & { accounts?: unknown }) | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.keybase as
    | (KeybaseAccountConfig & { accounts?: unknown })
    | undefined;
}

function mergeKeybaseAccountConfig(cfg: OpenClawConfig, accountId: string): KeybaseAccountConfig {
  const channelConfig = getKeybaseChannelConfig(cfg);
  const { accounts: _ignored, ...base } = (channelConfig ?? {}) as KeybaseAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveKeybaseAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedKeybaseAccount {
  const accountId = normalizeAccountId(params.accountId);
  const channelConfig = getKeybaseChannelConfig(params.cfg);
  const baseEnabled = channelConfig?.enabled !== false;
  const merged = mergeKeybaseAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const configured = Boolean(
    channelConfig?.enabled === true || merged.allowFrom?.length || merged.dmPolicy,
  );
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    configured,
    config: merged,
  };
}

export function listEnabledKeybaseAccounts(cfg: OpenClawConfig): ResolvedKeybaseAccount[] {
  return listKeybaseAccountIds(cfg)
    .map((accountId) => resolveKeybaseAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
