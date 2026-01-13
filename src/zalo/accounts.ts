/**
 * Zalo account resolution and configuration
 */

import type { ClawdbotConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { resolveZaloToken } from "./token.js";

export type ZaloAccountConfig = {
  enabled?: boolean;
  botToken?: string;
  tokenFile?: string;
  name?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "pairing";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist";
  groups?: Record<string, unknown>;
  mediaMaxMb?: number;
  historyLimit?: number;
  proxy?: string;
};

export type ResolvedZaloAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: "env" | "config" | "configFile" | "none";
  config: ZaloAccountConfig;
};

/**
 * List all configured Zalo account IDs
 */
export function listZaloAccountIds(cfg: ClawdbotConfig): string[] {
  const zaloConfig = cfg.channels?.zalo;
  if (!zaloConfig) return [];

  const accountIds = new Set<string>();

  // Check if base config has a token (default account)
  const { token: baseToken } = resolveZaloToken(cfg, DEFAULT_ACCOUNT_ID);
  if (baseToken) {
    accountIds.add(DEFAULT_ACCOUNT_ID);
  }

  // Add explicitly configured accounts
  const accounts = zaloConfig.accounts;
  if (accounts && typeof accounts === "object") {
    for (const id of Object.keys(accounts)) {
      accountIds.add(id);
    }
  }

  return Array.from(accountIds);
}

/**
 * Resolve the default Zalo account ID
 */
export function resolveDefaultZaloAccountId(cfg: ClawdbotConfig): string {
  const zaloConfig = cfg.channels?.zalo;

  // Check for explicit default
  if (zaloConfig?.defaultAccount) {
    return zaloConfig.defaultAccount;
  }

  // If base config has token, use default
  const { token: baseToken } = resolveZaloToken(cfg, DEFAULT_ACCOUNT_ID);
  if (baseToken) {
    return DEFAULT_ACCOUNT_ID;
  }

  // Otherwise, use first configured account
  const accountIds = listZaloAccountIds(cfg);
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a Zalo account by ID
 */
export function resolveZaloAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedZaloAccount {
  const { cfg, accountId } = params;
  const resolvedAccountId = accountId ?? resolveDefaultZaloAccountId(cfg);
  const zaloConfig = cfg.channels?.zalo;

  // Get token
  const { token, tokenSource } = resolveZaloToken(cfg, resolvedAccountId);

  // Get account-specific config
  const accountConfig =
    resolvedAccountId !== DEFAULT_ACCOUNT_ID
      ? (zaloConfig?.accounts?.[resolvedAccountId] as
          | ZaloAccountConfig
          | undefined)
      : undefined;

  // Merge base config with account config
  const mergedConfig: ZaloAccountConfig = {
    enabled: zaloConfig?.enabled,
    dmPolicy: zaloConfig?.dmPolicy as ZaloAccountConfig["dmPolicy"],
    allowFrom: zaloConfig?.allowFrom as ZaloAccountConfig["allowFrom"],
    groupPolicy: zaloConfig?.groupPolicy as ZaloAccountConfig["groupPolicy"],
    groups: zaloConfig?.groups as ZaloAccountConfig["groups"],
    webhookUrl: zaloConfig?.webhookUrl,
    webhookSecret: zaloConfig?.webhookSecret,
    webhookPath: zaloConfig?.webhookPath,
    mediaMaxMb: zaloConfig?.mediaMaxMb,
    historyLimit: zaloConfig?.historyLimit,
    proxy: zaloConfig?.proxy,
    ...accountConfig,
  };

  // Resolve enabled state
  const enabled =
    accountConfig?.enabled !== undefined
      ? accountConfig.enabled
      : zaloConfig?.enabled !== false;

  // Resolve name
  const name =
    accountConfig?.name ??
    (resolvedAccountId === DEFAULT_ACCOUNT_ID ? zaloConfig?.name : undefined);

  return {
    accountId: resolvedAccountId,
    name,
    enabled,
    token,
    tokenSource,
    config: mergedConfig,
  };
}
