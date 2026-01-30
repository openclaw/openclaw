/**
 * X channel account configuration helpers.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { XAccountConfig } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

/**
 * List all configured X account IDs.
 */
export function listXAccountIds(cfg: OpenClawConfig): string[] {
  const xConfig = (cfg.channels as Record<string, unknown> | undefined)?.x as
    | Record<string, unknown>
    | undefined;

  if (!xConfig) {
    return [];
  }

  const accounts = xConfig.accounts as Record<string, unknown> | undefined;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }

  // Check if simplified single-account config
  if (xConfig.consumerKey) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/**
 * Get account configuration by ID.
 */
export function resolveXAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): XAccountConfig | null {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const xConfig = (cfg.channels as Record<string, unknown> | undefined)?.x as
    | Record<string, unknown>
    | undefined;

  if (!xConfig) {
    return null;
  }

  const accounts = xConfig.accounts as Record<string, XAccountConfig> | undefined;

  // Multi-account mode
  if (accounts && resolvedAccountId in accounts) {
    return {
      ...accounts[resolvedAccountId],
      enabled: accounts[resolvedAccountId].enabled ?? true,
    };
  }

  // Simplified single-account mode (only for default account)
  if (resolvedAccountId === DEFAULT_ACCOUNT_ID && xConfig.consumerKey) {
    return {
      consumerKey: xConfig.consumerKey as string,
      consumerSecret: xConfig.consumerSecret as string,
      accessToken: xConfig.accessToken as string,
      accessTokenSecret: xConfig.accessTokenSecret as string,
      enabled: (xConfig.enabled as boolean) ?? true,
      pollIntervalSeconds: xConfig.pollIntervalSeconds as number | undefined,
      allowFrom: xConfig.allowFrom as string[] | undefined,
      name: xConfig.name as string | undefined,
    };
  }

  return null;
}

/**
 * Check if an account is configured with required credentials.
 */
export function isXAccountConfigured(account: XAccountConfig | null): boolean {
  if (!account) return false;
  return Boolean(
    account.consumerKey &&
    account.consumerSecret &&
    account.accessToken &&
    account.accessTokenSecret,
  );
}

/**
 * Resolve the default X account ID from config.
 */
export function resolveDefaultXAccountId(cfg: OpenClawConfig): string {
  const ids = listXAccountIds(cfg);
  return ids.length > 0 ? ids[0] : DEFAULT_ACCOUNT_ID;
}
