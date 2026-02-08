import type { OpenClawConfig } from "../config/config.js";
import type { SpixiAccountConfig } from "../config/types.spixi.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

export type ResolvedSpixiAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: SpixiAccountConfig;
};

export function listSpixiAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.spixi?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [DEFAULT_ACCOUNT_ID];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) {
      continue;
    }
    ids.add(normalizeAccountId(key));
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function resolveSpixiAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSpixiAccount {
  const accountId = normalizeAccountId(params.accountId);
  const spixi = params.cfg.channels?.spixi;
  const accounts = spixi?.accounts || {};
  const accountConfig = accounts[accountId] || {};

  const baseConfig = (spixi || {}) as SpixiAccountConfig;
  const merged = { ...baseConfig, ...accountConfig };

  return {
    accountId,
    enabled: merged.enabled !== false,
    name: merged.name,
    config: merged,
  };
}
