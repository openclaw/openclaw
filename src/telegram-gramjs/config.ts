/**
 * Config adapter for Telegram GramJS accounts.
 *
 * Handles:
 * - Account listing and resolution
 * - Account enable/disable
 * - Multi-account configuration
 */

import type { OpenClawConfig } from "../config/config.js";
import type { TelegramGramJSConfig } from "../config/types.telegram-gramjs.js";
import type { ChannelConfigAdapter } from "../channels/plugins/types.adapters.js";
import type { ResolvedGramJSAccount } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("telegram-gramjs:config");

const DEFAULT_ACCOUNT_ID = "default";

/**
 * Get the root Telegram GramJS config from openclaw config.
 */
function getGramJSConfig(cfg: OpenClawConfig): TelegramGramJSConfig {
  return (cfg.telegramGramjs ?? {}) as TelegramGramJSConfig;
}

/**
 * List all configured Telegram GramJS account IDs.
 */
export function listAccountIds(cfg: OpenClawConfig): string[] {
  const gramjsConfig = getGramJSConfig(cfg);

  // If accounts map exists, use those keys
  if (gramjsConfig.accounts && Object.keys(gramjsConfig.accounts).length > 0) {
    return Object.keys(gramjsConfig.accounts);
  }

  // If root config has credentials, return default account
  if (gramjsConfig.apiId && gramjsConfig.apiHash) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/**
 * Resolve a specific account configuration.
 */
export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedGramJSAccount {
  const gramjsConfig = getGramJSConfig(cfg);
  const accounts = listAccountIds(cfg);

  // If no accounts configured, return disabled default
  if (accounts.length === 0) {
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: false,
      config: {},
    };
  }

  // Determine which account to resolve
  let targetId = accountId || DEFAULT_ACCOUNT_ID;
  if (!accounts.includes(targetId)) {
    targetId = accounts[0]; // Fall back to first account
  }

  // Multi-account config
  if (gramjsConfig.accounts?.[targetId]) {
    const accountConfig = gramjsConfig.accounts[targetId];
    return {
      accountId: targetId,
      name: accountConfig.name,
      enabled: accountConfig.enabled !== false,
      config: accountConfig,
    };
  }

  // Single-account (root) config
  if (targetId === DEFAULT_ACCOUNT_ID) {
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      name: gramjsConfig.name,
      enabled: gramjsConfig.enabled !== false,
      config: gramjsConfig,
    };
  }

  // Account not found
  log.warn(`Account ${targetId} not found, returning disabled account`);
  return {
    accountId: targetId,
    enabled: false,
    config: {},
  };
}

/**
 * Get the default account ID.
 */
export function defaultAccountId(cfg: OpenClawConfig): string {
  const accounts = listAccountIds(cfg);
  return accounts.length > 0 ? accounts[0] : DEFAULT_ACCOUNT_ID;
}

/**
 * Set account enabled state.
 */
export function setAccountEnabled(params: {
  cfg: OpenClawConfig;
  accountId: string;
  enabled: boolean;
}): OpenClawConfig {
  const { cfg, accountId, enabled } = params;
  const gramjsConfig = getGramJSConfig(cfg);

  // Multi-account config
  if (gramjsConfig.accounts?.[accountId]) {
    return {
      ...cfg,
      telegramGramjs: {
        ...gramjsConfig,
        accounts: {
          ...gramjsConfig.accounts,
          [accountId]: {
            ...gramjsConfig.accounts[accountId],
            enabled,
          },
        },
      },
    };
  }

  // Single-account (root) config
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      telegramGramjs: {
        ...gramjsConfig,
        enabled,
      },
    };
  }

  log.warn(`Cannot set enabled state for non-existent account: ${accountId}`);
  return cfg;
}

/**
 * Delete an account from config.
 */
export function deleteAccount(params: { cfg: OpenClawConfig; accountId: string }): OpenClawConfig {
  const { cfg, accountId } = params;
  const gramjsConfig = getGramJSConfig(cfg);

  // Can't delete from single-account (root) config
  if (accountId === DEFAULT_ACCOUNT_ID && !gramjsConfig.accounts) {
    log.warn("Cannot delete default account in single-account config");
    return cfg;
  }

  // Multi-account config
  if (gramjsConfig.accounts?.[accountId]) {
    const { [accountId]: _removed, ...remainingAccounts } = gramjsConfig.accounts;
    return {
      ...cfg,
      telegramGramjs: {
        ...gramjsConfig,
        accounts: remainingAccounts,
      },
    };
  }

  log.warn(`Account ${accountId} not found, nothing to delete`);
  return cfg;
}

/**
 * Check if account is enabled.
 */
export function isEnabled(account: ResolvedGramJSAccount, _cfg: OpenClawConfig): boolean {
  return account.enabled;
}

/**
 * Get reason why account is disabled (if applicable).
 */
export function disabledReason(account: ResolvedGramJSAccount, _cfg: OpenClawConfig): string {
  if (account.enabled) return "";
  return "Account is disabled in config (enabled: false)";
}

/**
 * Check if account is fully configured (has credentials + session).
 */
export function isConfigured(account: ResolvedGramJSAccount, _cfg: OpenClawConfig): boolean {
  const { config } = account;

  // Need API credentials
  if (!config.apiId || !config.apiHash) {
    return false;
  }

  // Need session string (or session file)
  if (!config.sessionString && !config.sessionFile) {
    return false;
  }

  return true;
}

/**
 * Get reason why account is not configured (if applicable).
 */
export function unconfiguredReason(account: ResolvedGramJSAccount, _cfg: OpenClawConfig): string {
  const { config } = account;

  if (!config.apiId || !config.apiHash) {
    return "Missing API credentials (apiId, apiHash). Get them from https://my.telegram.org/apps";
  }

  if (!config.sessionString && !config.sessionFile) {
    return "Missing session. Run 'openclaw setup telegram-gramjs' to authenticate.";
  }

  return "";
}

/**
 * Get a snapshot of account state for display.
 */
export function describeAccount(account: ResolvedGramJSAccount, cfg: OpenClawConfig) {
  const { accountId, name, enabled, config } = account;

  return {
    id: accountId,
    name: name || accountId,
    enabled,
    configured: isConfigured(account, cfg),
    hasSession: !!(config.sessionString || config.sessionFile),
    phoneNumber: config.phoneNumber,
    dmPolicy: config.dmPolicy || "pairing",
    groupPolicy: config.groupPolicy || "open",
  };
}

/**
 * Resolve allowFrom list for an account.
 */
export function resolveAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] | undefined {
  const { cfg, accountId } = params;
  const account = resolveAccount(cfg, accountId);
  return account.config.allowFrom?.map(String);
}

/**
 * Format allowFrom entries (normalize user IDs and usernames).
 */
export function formatAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowFrom: Array<string | number>;
}): string[] {
  return params.allowFrom.map((entry) => {
    if (typeof entry === "number") {
      return entry.toString();
    }
    // Normalize username: remove @ prefix if present
    return entry.startsWith("@") ? entry.slice(1) : entry;
  });
}

/**
 * Export the config adapter.
 */
export const configAdapter: ChannelConfigAdapter<ResolvedGramJSAccount> = {
  listAccountIds,
  resolveAccount,
  defaultAccountId,
  setAccountEnabled,
  deleteAccount,
  isEnabled,
  disabledReason,
  isConfigured,
  unconfiguredReason,
  describeAccount,
  resolveAllowFrom,
  formatAllowFrom,
};
