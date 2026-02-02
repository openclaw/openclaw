// KOOK Account Management

import type { KookAccountConfig, KookGuildEntry } from "../config/types.kook.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveKookToken } from "./token.js";

// Account ID normalization
export const DEFAULT_ACCOUNT_ID = "default";

export function normalizeAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return trimmed && trimmed !== "" ? trimmed : DEFAULT_ACCOUNT_ID;
}

// Re-export types from central types.kook.ts
export type { KookAccountConfig, KookGuildEntry };

export type ResolvedKookAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  config: KookAccountConfig;
};

/**
 * List all configured KOOK account IDs
 */
export function listKookAccountIds(cfg: OpenClawConfig): string[] {
  const kookCfg = cfg?.channels?.kook as Record<string, unknown> | undefined;
  const accountsCfg = kookCfg?.accounts as Record<string, unknown> | undefined;

  const ids = new Set<string>();
  ids.add(DEFAULT_ACCOUNT_ID);

  if (accountsCfg && typeof accountsCfg === "object") {
    for (const key of Object.keys(accountsCfg)) {
      ids.add(key);
    }
  }

  return Array.from(ids);
}

/**
 * Merge base config with account-specific config
 */
function mergeKookAccountConfig(cfg: OpenClawConfig, accountId: string): KookAccountConfig {
  const kookCfg = cfg?.channels?.kook as Record<string, unknown> | undefined;
  const accountsCfg = kookCfg?.accounts as Record<string, Record<string, unknown>> | undefined;
  const accountCfg = accountsCfg?.[accountId];

  // Base config (without accounts)
  const base: KookAccountConfig = {
    enabled: kookCfg?.enabled as boolean | undefined,
    dm: kookCfg?.dm as KookAccountConfig["dm"],
    groupPolicy: kookCfg?.groupPolicy as KookAccountConfig["groupPolicy"],
    historyLimit: kookCfg?.historyLimit as number | undefined,
    mediaMaxMb: kookCfg?.mediaMaxMb as number | undefined,
    textChunkLimit: kookCfg?.textChunkLimit as number | undefined,
    replyToMode: kookCfg?.replyToMode as KookAccountConfig["replyToMode"],
    guilds: kookCfg?.guilds as KookAccountConfig["guilds"],
  };

  // Merge with account config
  if (accountCfg) {
    return {
      ...base,
      ...accountCfg,
      dm: { ...base.dm, ...(accountCfg.dm as KookAccountConfig["dm"]) },
      guilds: { ...base.guilds, ...(accountCfg.guilds as KookAccountConfig["guilds"]) },
    } as KookAccountConfig;
  }

  return base;
}

/**
 * Resolve a KOOK account by ID
 */
export function resolveKookAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedKookAccount {
  const accountId = normalizeAccountId(params.accountId);

  // Merge config
  const merged = mergeKookAccountConfig(params.cfg, accountId);

  // Check enabled status
  const kookCfg = params.cfg?.channels?.kook as Record<string, unknown> | undefined;
  const baseEnabled = kookCfg?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  // Resolve token
  const tokenResolution = resolveKookToken(params.cfg, { accountId });

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged,
  };
}
