import type { OpenClawConfig } from "../../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

/**
 * Auto-configures Discord and/or Telegram channels when tokens are provided
 * via CLI flags (--discord-token, --telegram-token).
 *
 * This enables fully non-interactive onboarding with channel setup:
 *   openclaw onboard --non-interactive --accept-risk --discord-token <token>
 */
export function applyNonInteractiveChannelTokens(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
}): OpenClawConfig {
  let cfg = params.nextConfig;

  const discordToken = params.opts.discordToken?.trim();
  if (discordToken) {
    cfg = applyDiscordToken(cfg, discordToken);
    params.runtime.log("Discord channel auto-configured from --discord-token.");
  }

  const telegramToken = params.opts.telegramToken?.trim();
  if (telegramToken) {
    cfg = applyTelegramToken(cfg, telegramToken);
    params.runtime.log("Telegram channel auto-configured from --telegram-token.");
  }

  return cfg;
}

function applyDiscordToken(cfg: OpenClawConfig, token: string): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      discord: {
        ...cfg.channels?.discord,
        accounts: {
          ...cfg.channels?.discord?.accounts,
          [DEFAULT_ACCOUNT_ID]: {
            ...cfg.channels?.discord?.accounts?.[DEFAULT_ACCOUNT_ID],
            token,
          },
        },
      },
    },
  };
}

function applyTelegramToken(cfg: OpenClawConfig, token: string): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      telegram: {
        ...cfg.channels?.telegram,
        accounts: {
          ...cfg.channels?.telegram?.accounts,
          [DEFAULT_ACCOUNT_ID]: {
            ...cfg.channels?.telegram?.accounts?.[DEFAULT_ACCOUNT_ID],
            botToken: token,
          },
        },
      },
    },
  };
}
