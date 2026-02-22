import type { OpenClawConfig } from "../config/config.js";
import type { WatiAccountConfig } from "../config/types.wati.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { listBoundAccountIds, resolveDefaultAgentBoundAccountId } from "../routing/bindings.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_WATI_ACCOUNTS)) {
    console.warn("[wati:accounts]", ...args);
  }
};

export type WatiTokenSource = "env" | "config" | "none";

export type ResolvedWatiAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  apiToken: string;
  apiTokenSource: WatiTokenSource;
  apiBaseUrl: string;
  tenantId?: string;
  config: WatiAccountConfig;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels as Record<string, unknown>)?.wati as
    | { accounts?: Record<string, unknown> }
    | undefined;
  const accts = accounts?.accounts;
  if (!accts || typeof accts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accts)) {
    if (!key) {
      continue;
    }
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

export function listWatiAccountIds(cfg: OpenClawConfig): string[] {
  const ids = Array.from(
    new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "wati")]),
  );
  debugAccounts("listWatiAccountIds", ids);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultWatiAccountId(cfg: OpenClawConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "wati");
  if (boundDefault) {
    return boundDefault;
  }
  const ids = listWatiAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): WatiAccountConfig | undefined {
  const watiCfg = (cfg.channels as Record<string, unknown>)?.wati as
    | { accounts?: Record<string, WatiAccountConfig> }
    | undefined;
  const accounts = watiCfg?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? accounts[matchKey] : undefined;
}

function mergeWatiAccountConfig(cfg: OpenClawConfig, accountId: string): WatiAccountConfig {
  const watiCfg = (cfg.channels as Record<string, unknown>)?.wati as
    | (WatiAccountConfig & { accounts?: unknown })
    | undefined;
  const { accounts: _ignored, ...base } = watiCfg ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveWatiToken(
  cfg: OpenClawConfig,
  accountId: string,
): { token: string; source: WatiTokenSource } {
  const merged = mergeWatiAccountConfig(cfg, accountId);

  // Per-account config token
  const accountToken = merged.apiToken?.trim();
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }

  // Env var fallback (only for default account)
  const allowEnv = normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.WATI_API_TOKEN?.trim() : "";
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}

export function resolveWatiAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWatiAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const watiCfg = (params.cfg.channels as Record<string, unknown>)?.wati as
    | { enabled?: boolean }
    | undefined;
  const baseEnabled = watiCfg?.enabled !== false;

  const resolve = (accountId: string): ResolvedWatiAccount => {
    const merged = mergeWatiAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveWatiToken(params.cfg, accountId);
    debugAccounts("resolve", {
      accountId,
      enabled,
      tokenSource: tokenResolution.source,
    });
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      apiToken: tokenResolution.token,
      apiTokenSource: tokenResolution.source,
      apiBaseUrl: (merged.apiBaseUrl || "https://live-mt-server.wati.io").replace(/\/+$/, ""),
      tenantId: merged.tenantId?.trim() || undefined,
      config: merged,
    };
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.apiTokenSource !== "none") {
    return primary;
  }

  // Fallback: prefer a configured account token over failing on the implicit "default" account.
  const fallbackId = resolveDefaultWatiAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (fallback.apiTokenSource === "none") {
    return primary;
  }
  return fallback;
}

export function listEnabledWatiAccounts(cfg: OpenClawConfig): ResolvedWatiAccount[] {
  return listWatiAccountIds(cfg)
    .map((accountId) => resolveWatiAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
