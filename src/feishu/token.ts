import fs from "node:fs";

import type { OpenClawConfig } from "../config/config.js";
import type { FeishuAccountConfig } from "../config/types.feishu.js";
import { resolveUserPath } from "../utils.js";

export type FeishuTokenSource = "env" | "secretFile" | "config" | "none";

export type FeishuCredentials = {
  appId: string;
  appSecret: string;
  source: FeishuTokenSource;
};

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): FeishuAccountConfig | undefined {
  const accounts = cfg.channels?.feishu?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const direct = accounts[accountId] as FeishuAccountConfig | undefined;
  if (direct) return direct;
  const normalized = accountId.toLowerCase().trim();
  const matchKey = Object.keys(accounts).find((key) => key.toLowerCase().trim() === normalized);
  return matchKey ? (accounts[matchKey] as FeishuAccountConfig | undefined) : undefined;
}

function mergeFeishuAccountConfig(cfg: OpenClawConfig, accountId: string): FeishuAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.feishu ?? {}) as FeishuAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function readSecretFile(filePath: string): string | undefined {
  try {
    const resolved = resolveUserPath(filePath);
    if (!fs.existsSync(resolved)) return undefined;
    return fs.readFileSync(resolved, "utf-8").trim();
  } catch {
    return undefined;
  }
}

export function resolveFeishuCredentials(
  cfg: OpenClawConfig,
  opts?: { accountId?: string | null },
): FeishuCredentials {
  const accountId = opts?.accountId?.trim() || "default";
  const merged = mergeFeishuAccountConfig(cfg, accountId);

  // Try environment variables first
  const envAppId = process.env.FEISHU_APP_ID?.trim();
  const envAppSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (envAppId && envAppSecret) {
    return { appId: envAppId, appSecret: envAppSecret, source: "env" };
  }

  // Try secret file
  if (merged.appSecretFile && merged.appId) {
    const secretFromFile = readSecretFile(merged.appSecretFile);
    if (secretFromFile) {
      return { appId: merged.appId, appSecret: secretFromFile, source: "secretFile" };
    }
  }

  // Try config values
  if (merged.appId && merged.appSecret) {
    return { appId: merged.appId, appSecret: merged.appSecret, source: "config" };
  }

  return { appId: "", appSecret: "", source: "none" };
}

export function resolveFeishuVerificationToken(
  cfg: OpenClawConfig,
  opts?: { accountId?: string | null },
): string | undefined {
  const accountId = opts?.accountId?.trim() || "default";
  const merged = mergeFeishuAccountConfig(cfg, accountId);

  // Try environment variable first
  const envToken = process.env.FEISHU_VERIFICATION_TOKEN?.trim();
  if (envToken) return envToken;

  return merged.verificationToken?.trim();
}

export function resolveFeishuEncryptKey(
  cfg: OpenClawConfig,
  opts?: { accountId?: string | null },
): string | undefined {
  const accountId = opts?.accountId?.trim() || "default";
  const merged = mergeFeishuAccountConfig(cfg, accountId);

  // Try environment variable first
  const envKey = process.env.FEISHU_ENCRYPT_KEY?.trim();
  if (envKey) return envKey;

  return merged.encryptKey?.trim();
}
