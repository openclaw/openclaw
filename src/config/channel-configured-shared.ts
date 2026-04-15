import { hasNonEmptyString } from "../infra/outbound/channel-target.js";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./config.js";

const STATIC_ENV_RULES: Record<string, string[] | ((env: NodeJS.ProcessEnv) => boolean)> = {
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN"],
  telegram: ["TELEGRAM_BOT_TOKEN"],
  irc: (env) => hasNonEmptyString(env.IRC_HOST) && hasNonEmptyString(env.IRC_NICK),
};

export function resolveChannelConfigRecord(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  return isRecord(entry) ? entry : null;
}

export function hasMeaningfulChannelConfigShallow(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => key !== "enabled");
}

export function isStaticallyChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const staticRule = STATIC_ENV_RULES[channelId];
  if (Array.isArray(staticRule)) {
    for (const envVar of staticRule) {
      if (hasNonEmptyString(env[envVar])) {
        return true;
      }
    }
  } else if (staticRule?.(env)) {
    return true;
  }
  return hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId));
}
