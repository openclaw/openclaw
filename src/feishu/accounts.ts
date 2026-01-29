import type { MoltbotConfig } from "../config/config.js";
import type { FeishuAccountConfig } from "../config/types.feishu.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { listBoundAccountIds, resolveDefaultAgentBoundAccountId } from "../routing/bindings.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { resolveFeishuCredentials, type FeishuCredentials } from "./token.js";

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.CLAWDBOT_DEBUG_FEISHU_ACCOUNTS)) {
    console.warn("[feishu:accounts]", ...args);
  }
};

/** Normalize startupChatId config (string or string[]) to a non-empty string array. */
export function getStartupChatIds(config: FeishuAccountConfig): string[] {
  const raw = config.startupChatId;
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).trim()).filter(Boolean);
  }
  if (raw != null && String(raw).trim()) {
    return [String(raw).trim()];
  }
  return [];
}

export type ResolvedFeishuAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  credentials: FeishuCredentials;
  config: FeishuAccountConfig;
};

function listConfiguredAccountIds(cfg: MoltbotConfig): string[] {
  const accounts = cfg.channels?.feishu?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) continue;
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

export function listFeishuAccountIds(cfg: MoltbotConfig): string[] {
  const ids = Array.from(
    new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "feishu")]),
  );
  debugAccounts("listFeishuAccountIds", ids);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultFeishuAccountId(cfg: MoltbotConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "feishu");
  if (boundDefault) return boundDefault;
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: MoltbotConfig,
  accountId: string,
): FeishuAccountConfig | undefined {
  const accounts = cfg.channels?.feishu?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const direct = accounts[accountId] as FeishuAccountConfig | undefined;
  if (direct) return direct;
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as FeishuAccountConfig | undefined) : undefined;
}

function mergeFeishuAccountConfig(cfg: MoltbotConfig, accountId: string): FeishuAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.feishu ?? {}) as FeishuAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveFeishuAccount(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.feishu?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeFeishuAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const credentials = resolveFeishuCredentials(params.cfg, { accountId });
    debugAccounts("resolve", {
      accountId,
      enabled,
      credentialSource: credentials.source,
    });
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      credentials,
      config: merged,
    } satisfies ResolvedFeishuAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) return primary;
  if (primary.credentials.source !== "none") return primary;

  // If accountId is omitted, prefer a configured account credential over failing on
  // the implicit "default" account.
  const fallbackId = resolveDefaultFeishuAccountId(params.cfg);
  if (fallbackId === primary.accountId) return primary;
  const fallback = resolve(fallbackId);
  if (fallback.credentials.source === "none") return primary;
  return fallback;
}

export function listEnabledFeishuAccounts(cfg: MoltbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
