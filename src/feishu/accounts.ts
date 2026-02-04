import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import type { FeishuAccountConfig } from "../config/types.feishu.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

export type FeishuTokenSource = "config" | "file" | "env" | "none";

export type ResolvedFeishuAccount = {
  accountId: string;
  config: FeishuAccountConfig;
  tokenSource: FeishuTokenSource;
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
): FeishuAccountConfig | undefined {
  const accounts = cfg.channels?.feishu?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as FeishuAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as FeishuAccountConfig | undefined) : undefined;
}

function mergeFeishuAccountConfig(cfg: OpenClawConfig, accountId: string): FeishuAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.feishu ?? {}) as FeishuAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveAppSecret(config?: { appSecret?: string; appSecretFile?: string }): {
  value?: string;
  source?: Exclude<FeishuTokenSource, "env" | "none">;
} {
  const direct = config?.appSecret?.trim();
  if (direct) {
    return { value: direct, source: "config" };
  }
  const fromFile = readFileIfExists(config?.appSecretFile);
  if (fromFile) {
    return { value: fromFile, source: "file" };
  }
  return {};
}

export function listFeishuAccountIds(cfg: OpenClawConfig): string[] {
  const feishuCfg = cfg.channels?.feishu;
  const accounts = feishuCfg?.accounts;
  const ids = new Set<string>();

  const baseConfigured = Boolean(
    feishuCfg?.appId?.trim() && (feishuCfg?.appSecret?.trim() || Boolean(feishuCfg?.appSecretFile)),
  );
  const envConfigured = Boolean(
    process.env.FEISHU_APP_ID?.trim() && process.env.FEISHU_APP_SECRET?.trim(),
  );
  if (baseConfigured || envConfigured) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (accounts) {
    for (const id of Object.keys(accounts)) {
      ids.add(normalizeAccountId(id));
    }
  }

  return Array.from(ids);
}

export function resolveDefaultFeishuAccountId(cfg: OpenClawConfig): string {
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveFeishuAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.feishu?.enabled !== false;
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envAppId = allowEnv ? process.env.FEISHU_APP_ID?.trim() : undefined;
  const envAppSecret = allowEnv ? process.env.FEISHU_APP_SECRET?.trim() : undefined;

  const appId = merged.appId?.trim() || envAppId || "";
  const secretResolution = resolveAppSecret(merged);
  const appSecret = secretResolution.value ?? envAppSecret ?? "";

  let tokenSource: FeishuTokenSource = "none";
  if (secretResolution.value) {
    tokenSource = secretResolution.source ?? "config";
  } else if (envAppSecret) {
    tokenSource = "env";
  }
  if (!appId || !appSecret) {
    tokenSource = "none";
  }

  const config: FeishuAccountConfig = {
    ...merged,
    appId,
    appSecret,
  };

  const name = config.name?.trim() || config.botName?.trim() || undefined;

  return {
    accountId,
    config,
    tokenSource,
    name,
    enabled,
  };
}
