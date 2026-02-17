import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import type { LinqAccountConfig } from "./types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

export type ResolvedLinqAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "config" | "env" | "file" | "none";
  fromPhone?: string;
  config: LinqAccountConfig;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels as Record<string, unknown> | undefined)?.linq as
    | LinqAccountConfig
    | undefined;
  if (!accounts?.accounts || typeof accounts.accounts !== "object") {
    return [];
  }
  return Object.keys(accounts.accounts).filter(Boolean);
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
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
    | LinqAccountConfig
    | undefined;
  if (!linqSection?.accounts || typeof linqSection.accounts !== "object") {
    return undefined;
  }
  return linqSection.accounts[accountId];
}

function mergeLinqAccountConfig(cfg: OpenClawConfig, accountId: string): LinqAccountConfig {
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
    | (LinqAccountConfig & { accounts?: unknown })
    | undefined;
  const { accounts: _ignored, ...base } = linqSection ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveToken(
  merged: LinqAccountConfig,
  accountId: string,
): { token: string; source: "config" | "env" | "file" } | { token: ""; source: "none" } {
  // Environment variable takes priority for the default account.
  const envToken = process.env.LINQ_API_TOKEN?.trim() ?? "";
  if (envToken && accountId === DEFAULT_ACCOUNT_ID) {
    return { token: envToken, source: "env" };
  }
  // Config token.
  if (merged.apiToken?.trim()) {
    return { token: merged.apiToken.trim(), source: "config" };
  }
  // Token file (read synchronously to keep resolver sync-friendly).
  if (merged.tokenFile?.trim()) {
    try {
      const content = readFileSync(merged.tokenFile.trim(), "utf8").trim();
      if (content) {
        return { token: content, source: "file" };
      }
    } catch {
      // fall through
    }
  }
  return { token: "", source: "none" };
}

export function resolveLinqAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedLinqAccount {
  const accountId = normalizeAccountId(params.accountId);
  const linqSection = (params.cfg.channels as Record<string, unknown> | undefined)?.linq as
    | LinqAccountConfig
    | undefined;
  const baseEnabled = linqSection?.enabled !== false;
  const merged = mergeLinqAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const { token, source } = resolveToken(merged, accountId);
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    token,
    tokenSource: source,
    fromPhone: merged.fromPhone?.trim() || undefined,
    config: merged,
  };
}
