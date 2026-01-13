/**
 * Zalo token resolution
 */

import { readFileSync } from "node:fs";
import type { ClawdbotConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

export type ZaloTokenResolution = {
  token: string;
  tokenSource: "env" | "config" | "configFile" | "none";
};

/**
 * Resolve the Zalo bot token for an account.
 *
 * Resolution precedence:
 * 1. Account-level config (`channels.zalo.accounts[accountId].botToken`)
 * 2. Account-level tokenFile (`channels.zalo.accounts[accountId].tokenFile`)
 * 3. Base config (`channels.zalo.botToken`) - default account only
 * 4. Base tokenFile (`channels.zalo.tokenFile`) - default account only
 * 5. Environment variable (`ZALO_BOT_TOKEN`) - default account only
 */
export function resolveZaloToken(
  cfg: ClawdbotConfig,
  accountId?: string | null,
): ZaloTokenResolution {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const zaloConfig = cfg.channels?.zalo;

  // Check account-level config first
  if (resolvedAccountId !== DEFAULT_ACCOUNT_ID) {
    const accountConfig = zaloConfig?.accounts?.[resolvedAccountId];
    if (accountConfig) {
      // Account botToken
      const accountToken =
        typeof accountConfig === "object"
          ? (accountConfig as { botToken?: string }).botToken?.trim()
          : undefined;
      if (accountToken) {
        return { token: accountToken, tokenSource: "config" };
      }

      // Account tokenFile
      const accountTokenFile =
        typeof accountConfig === "object"
          ? (accountConfig as { tokenFile?: string }).tokenFile?.trim()
          : undefined;
      if (accountTokenFile) {
        try {
          const fileToken = readFileSync(accountTokenFile, "utf-8").trim();
          if (fileToken) {
            return { token: fileToken, tokenSource: "configFile" };
          }
        } catch {
          // File not readable, fall through
        }
      }
    }
  }

  // For default account (or fallback), check base config
  if (isDefaultAccount) {
    // Base botToken
    const baseToken = zaloConfig?.botToken?.trim();
    if (baseToken) {
      return { token: baseToken, tokenSource: "config" };
    }

    // Base tokenFile
    const baseTokenFile = zaloConfig?.tokenFile?.trim();
    if (baseTokenFile) {
      try {
        const fileToken = readFileSync(baseTokenFile, "utf-8").trim();
        if (fileToken) {
          return { token: fileToken, tokenSource: "configFile" };
        }
      } catch {
        // File not readable, fall through
      }
    }

    // Environment variable (default account only)
    const envToken = process.env.ZALO_BOT_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, tokenSource: "env" };
    }
  }

  return { token: "", tokenSource: "none" };
}
