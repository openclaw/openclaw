import type { BotConfig } from "../config/config.js";
import type { DiscordActionConfig } from "../config/types.discord.js";
import type { DiscordAccountConfig } from "../config/types.js";
import {
  createAccountActionGate,
  type ActionGate,
} from "../channels/plugins/account-action-gate.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { resolveDiscordToken } from "./token.js";

export type ResolvedDiscordAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  config: DiscordAccountConfig;
};

function listConfiguredAccountIds(cfg: BotConfig): string[] {
  const accounts = cfg.channels?.discord?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listDiscordAccountIds(cfg: BotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultDiscordAccountId(cfg: BotConfig): string {
  const ids = listDiscordAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: BotConfig, accountId: string): DiscordAccountConfig | undefined {
  const accounts = cfg.channels?.discord?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as DiscordAccountConfig | undefined;
}

function mergeDiscordAccountConfig(cfg: BotConfig, accountId: string): DiscordAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.discord ?? {}) as DiscordAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveDiscordAccount(params: {
  cfg: BotConfig;
  accountId?: string | null;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged,
  };
}

export function listEnabledDiscordAccounts(cfg: BotConfig): ResolvedDiscordAccount[] {
  return listDiscordAccountIds(cfg)
    .map((accountId) => resolveDiscordAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

/** Build an action gate for Discord that merges base + account action configs. */
export function createDiscordActionGate(params: {
  cfg: BotConfig;
  accountId?: string | null;
}): ActionGate<DiscordActionConfig> {
  const baseActions = (params.cfg.channels?.discord as DiscordAccountConfig | undefined)?.actions;
  const account = resolveDiscordAccount(params);
  return createAccountActionGate({
    baseActions,
    accountActions: account.config.actions,
  });
}
