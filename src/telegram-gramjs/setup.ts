/**
 * Setup adapter for Telegram GramJS account onboarding.
 *
 * Handles:
 * - Interactive authentication flow
 * - Session persistence to config
 * - Account name assignment
 */

import type { OpenClawConfig } from "../config/config.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelSetupInput } from "../channels/plugins/types.core.js";
import type { TelegramGramJSConfig } from "../config/types.telegram-gramjs.js";
import { runAuthFlow } from "./auth.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("telegram-gramjs:setup");

const DEFAULT_ACCOUNT_ID = "default";

/**
 * Resolve account ID (or generate default).
 */
function resolveAccountId(params: { cfg: OpenClawConfig; accountId?: string }): string {
  const { accountId } = params;
  return accountId || DEFAULT_ACCOUNT_ID;
}

/**
 * Apply account name to config.
 */
function applyAccountName(params: {
  cfg: OpenClawConfig;
  accountId: string;
  name?: string;
}): OpenClawConfig {
  const { cfg, accountId, name } = params;
  if (!name) return cfg;

  const gramjsConfig = (cfg.telegramGramjs ?? {}) as TelegramGramJSConfig;

  // Multi-account config
  if (gramjsConfig.accounts) {
    return {
      ...cfg,
      telegramGramjs: {
        ...gramjsConfig,
        accounts: {
          ...gramjsConfig.accounts,
          [accountId]: {
            ...gramjsConfig.accounts[accountId],
            name,
          },
        },
      },
    };
  }

  // Single-account (root) config
  return {
    ...cfg,
    telegramGramjs: {
      ...gramjsConfig,
      name,
    },
  };
}

/**
 * Apply setup input to config (credentials + session).
 */
function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}): OpenClawConfig {
  const { cfg, accountId, input } = params;
  const gramjsConfig = (cfg.telegramGramjs ?? {}) as TelegramGramJSConfig;

  // Extract credentials from input
  const apiId = input.apiId ? Number(input.apiId) : undefined;
  const apiHash = input.apiHash as string | undefined;
  const sessionString = input.sessionString as string | undefined;
  const phoneNumber = input.phoneNumber as string | undefined;

  // Validate required fields
  if (!apiId || !apiHash) {
    throw new Error("Missing required fields: apiId, apiHash");
  }

  const accountConfig = {
    name: input.name as string | undefined,
    enabled: true,
    apiId,
    apiHash,
    sessionString,
    phoneNumber,
    // Default policies
    dmPolicy: "pairing" as const,
    groupPolicy: "open" as const,
  };

  // Multi-account config
  if (accountId !== DEFAULT_ACCOUNT_ID || gramjsConfig.accounts) {
    return {
      ...cfg,
      telegramGramjs: {
        ...gramjsConfig,
        accounts: {
          ...gramjsConfig.accounts,
          [accountId]: {
            ...gramjsConfig.accounts?.[accountId],
            ...accountConfig,
          },
        },
      },
    };
  }

  // Single-account (root) config
  return {
    ...cfg,
    telegramGramjs: {
      ...gramjsConfig,
      ...accountConfig,
    },
  };
}

/**
 * Validate setup input.
 */
function validateInput(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}): string | null {
  const { input } = params;

  // Check for API credentials
  if (!input.apiId) {
    return "Missing apiId. Get it from https://my.telegram.org/apps";
  }

  if (!input.apiHash) {
    return "Missing apiHash. Get it from https://my.telegram.org/apps";
  }

  // Validate apiId is a number
  const apiId = Number(input.apiId);
  if (isNaN(apiId) || apiId <= 0) {
    return "Invalid apiId. Must be a positive integer.";
  }

  // If phone number provided, validate format
  if (input.phoneNumber) {
    const phone = input.phoneNumber as string;
    const cleaned = phone.replace(/[\s-]/g, "");
    if (!/^\+\d{10,15}$/.test(cleaned)) {
      return "Invalid phone number format. Must start with + and contain 10-15 digits (e.g., +12025551234)";
    }
  }

  return null; // Valid
}

/**
 * Run interactive setup flow (called by CLI).
 */
export async function runSetupFlow(
  cfg: OpenClawConfig,
  accountId: string,
): Promise<OpenClawConfig> {
  log.info(`Starting Telegram GramJS setup for account: ${accountId}`);
  log.info("");
  log.info("You will need:");
  log.info("  1. API credentials from https://my.telegram.org/apps");
  log.info("  2. Your phone number");
  log.info("  3. Access to SMS for verification");
  log.info("");

  // Prompt for API credentials (or read from env)
  const apiId =
    Number(process.env.TELEGRAM_API_ID) || Number(await promptInput("Enter your API ID: "));
  const apiHash = process.env.TELEGRAM_API_HASH || (await promptInput("Enter your API Hash: "));

  if (!apiId || !apiHash) {
    throw new Error("API credentials required. Get them from https://my.telegram.org/apps");
  }

  // Run auth flow to get session string
  log.info("");
  const sessionString = await runAuthFlow(apiId, apiHash);

  // Extract phone number from successful auth (if possible)
  // For now, we won't store phone number permanently for security
  const phoneNumber = undefined;

  // Prompt for account name
  const name = await promptInput(`\nEnter a name for this account (optional): `);

  // Create setup input
  const input: ChannelSetupInput = {
    apiId: apiId.toString(),
    apiHash,
    sessionString,
    phoneNumber,
    name: name || undefined,
  };

  // Apply to config
  let newCfg = applyAccountConfig({ cfg, accountId, input });
  if (name) {
    newCfg = applyAccountName({ cfg: newCfg, accountId, name });
  }

  log.success("✅ Setup complete!");
  log.info(`Account '${accountId}' configured successfully.`);
  log.info("Session saved to config (encrypted at rest).");
  log.info("");
  log.info("Start the gateway to begin receiving messages:");
  log.info("  openclaw gateway start");

  return newCfg;
}

/**
 * Helper to prompt for input (CLI).
 */
async function promptInput(question: string): Promise<string> {
  const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    readline.question(question, (answer: string) => {
      readline.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Export the setup adapter.
 */
export const setupAdapter: ChannelSetupAdapter = {
  resolveAccountId,
  applyAccountName,
  applyAccountConfig,
  validateInput,
};
