// KOOK Token Resolution
// Supports: environment variable, config file

import type { OpenClawConfig } from "../config/types.openclaw.js";

// Account ID normalization
export const DEFAULT_ACCOUNT_ID = "default";

export function normalizeAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return trimmed && trimmed !== "" ? trimmed : DEFAULT_ACCOUNT_ID;
}

export type KookTokenResolution = {
  token: string;
  source: "env" | "config" | "none";
};

/**
 * Normalize KOOK token (trim whitespace)
 */
export function normalizeKookToken(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

/**
 * Resolve KOOK token from config or environment
 * Priority: account config > base config > KOOK_BOT_TOKEN env
 */
export function resolveKookToken(
  cfg?: OpenClawConfig,
  opts: { accountId?: string | null; envToken?: string } = {},
): KookTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;

  // Get KOOK config
  const kookCfg = cfg?.channels?.kook as Record<string, unknown> | undefined;
  const accountsCfg = kookCfg?.accounts as Record<string, Record<string, unknown>> | undefined;
  const accountCfg = accountsCfg?.[accountId];

  // Priority 1: Account-specific token
  const accountToken = normalizeKookToken(accountCfg?.token as string | undefined);
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }

  // Priority 2: Base config token (only for default account)
  const configToken = allowEnv
    ? normalizeKookToken(kookCfg?.token as string | undefined)
    : undefined;
  if (configToken) {
    return { token: configToken, source: "config" };
  }

  // Priority 3: Environment variable (only for default account)
  const envToken = allowEnv
    ? normalizeKookToken(opts.envToken ?? process.env.KOOK_BOT_TOKEN)
    : undefined;
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
