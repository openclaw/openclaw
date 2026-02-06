import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import type { DingTalkAccountConfig } from "../config/types.dingtalk.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

export type DingTalkTokenSource = "config" | "file" | "none";

export type ResolvedDingTalkAccountConfig = DingTalkAccountConfig & {
  clientId: string;
  clientSecret: string;
};

export type ResolvedDingTalkAccount = {
  accountId: string;
  config: ResolvedDingTalkAccountConfig;
  tokenSource: DingTalkTokenSource;
  name?: string;
  enabled: boolean;
};

function readFileIfExists(filePath?: string): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DingTalkAccountConfig | undefined {
  const accounts = cfg.channels?.dingtalk?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as DingTalkAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as DingTalkAccountConfig | undefined) : undefined;
}

function mergeAccountConfig(cfg: OpenClawConfig, accountId: string): DingTalkAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.dingtalk ??
    {}) as DingTalkAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveClientSecret(config?: { clientSecret?: string; clientSecretFile?: string }): {
  value?: string;
  source?: Exclude<DingTalkTokenSource, "none">;
} {
  const direct = config?.clientSecret?.trim();
  if (direct) {
    return { value: direct, source: "config" };
  }
  const fromFile = readFileIfExists(config?.clientSecretFile);
  if (fromFile) {
    return { value: fromFile, source: "file" };
  }
  return {};
}

export function listDingTalkAccountIds(cfg: OpenClawConfig): string[] {
  const dtCfg = cfg.channels?.dingtalk;
  const accounts = dtCfg?.accounts;
  const ids = new Set<string>();
  const baseConfigured = Boolean(
    dtCfg?.clientId?.trim() && (dtCfg?.clientSecret?.trim() || dtCfg?.clientSecretFile),
  );
  if (baseConfigured) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  if (accounts) {
    for (const id of Object.keys(accounts)) {
      ids.add(normalizeAccountId(id));
    }
  }
  return Array.from(ids);
}

export function resolveDefaultDingTalkAccountId(cfg: OpenClawConfig): string {
  const ids = listDingTalkAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveDingTalkAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDingTalkAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.dingtalk?.enabled !== false;
  const merged = mergeAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const clientId = merged.clientId?.trim() || "";
  const secretResolution = resolveClientSecret(merged);
  const clientSecret = secretResolution.value ?? "";

  let tokenSource: DingTalkTokenSource = "none";
  if (secretResolution.value) {
    tokenSource = secretResolution.source ?? "config";
  }
  if (!clientId || !clientSecret) {
    tokenSource = "none";
  }

  const config: ResolvedDingTalkAccountConfig = { ...merged, clientId, clientSecret };
  const name = config.name?.trim() || undefined;

  return { accountId, config, tokenSource, name, enabled };
}
