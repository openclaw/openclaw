import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOAuthDir } from "../config/paths.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

const CHANNEL_ENV_PREFIXES = [
  ["BLUEBUBBLES_", "bluebubbles"],
  ["DISCORD_", "discord"],
  ["GOOGLECHAT_", "googlechat"],
  ["IRC_", "irc"],
  ["LINE_", "line"],
  ["MATRIX_", "matrix"],
  ["MSTEAMS_", "msteams"],
  ["SIGNAL_", "signal"],
  ["SLACK_", "slack"],
  ["TELEGRAM_", "telegram"],
  ["WHATSAPP_", "whatsapp"],
  ["ZALOUSER_", "zalouser"],
  ["ZALO_", "zalo"],
] as const;

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasMeaningfulChannelConfig(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => key !== "enabled");
}

function hasWhatsAppAuthState(env: NodeJS.ProcessEnv): boolean {
  try {
    const oauthDir = resolveOAuthDir(env);
    const legacyCreds = path.join(oauthDir, "creds.json");
    if (fs.existsSync(legacyCreds)) {
      return true;
    }

    const accountsRoot = path.join(oauthDir, "whatsapp");
    const defaultCreds = path.join(accountsRoot, DEFAULT_ACCOUNT_ID, "creds.json");
    if (fs.existsSync(defaultCreds)) {
      return true;
    }

    const entries = fs.readdirSync(accountsRoot, { withFileTypes: true });
    return entries.some((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      return fs.existsSync(path.join(accountsRoot, entry.name, "creds.json"));
    });
  } catch {
    return false;
  }
}

export function listPotentialConfiguredChannelIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configuredChannelIds = new Set<string>();
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  if (channels) {
    for (const [key, value] of Object.entries(channels)) {
      if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
        continue;
      }
      if (hasMeaningfulChannelConfig(value)) {
        configuredChannelIds.add(key);
      }
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (!hasNonEmptyString(value)) {
      continue;
    }
    for (const [prefix, channelId] of CHANNEL_ENV_PREFIXES) {
      if (key.startsWith(prefix)) {
        configuredChannelIds.add(channelId);
      }
    }
    if (key === "TELEGRAM_BOT_TOKEN") {
      configuredChannelIds.add("telegram");
    }
  }
  if (hasWhatsAppAuthState(env)) {
    configuredChannelIds.add("whatsapp");
  }
  return [...configuredChannelIds];
}

function hasEnvConfiguredChannel(env: NodeJS.ProcessEnv): boolean {
  for (const [key, value] of Object.entries(env)) {
    if (!hasNonEmptyString(value)) {
      continue;
    }
    if (
      CHANNEL_ENV_PREFIXES.some(([prefix]) => key.startsWith(prefix)) ||
      key === "TELEGRAM_BOT_TOKEN"
    ) {
      return true;
    }
  }
  return hasWhatsAppAuthState(env);
}

export function hasPotentialConfiguredChannels(
  cfg: OpenClawConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const channels = isRecord(cfg?.channels) ? cfg.channels : null;
  if (channels) {
    for (const [key, value] of Object.entries(channels)) {
      if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
        continue;
      }
      if (hasMeaningfulChannelConfig(value)) {
        return true;
      }
    }
  }
  return hasEnvConfiguredChannel(env);
}
