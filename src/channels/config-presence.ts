import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOAuthDir } from "../config/paths.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

const CHANNEL_ENV_PREFIXES = [
  "BLUEBUBBLES_",
  "DISCORD_",
  "GOOGLECHAT_",
  "IRC_",
  "LINE_",
  "MATRIX_",
  "MSTEAMS_",
  "SIGNAL_",
  "SLACK_",
  "TELEGRAM_",
  "WHATSAPP_",
  "ZALOUSER_",
  "ZALO_",
] as const;

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordHasKeys(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
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

function hasEnvConfiguredChannel(env: NodeJS.ProcessEnv): boolean {
  for (const [key, value] of Object.entries(env)) {
    if (!hasNonEmptyString(value)) {
      continue;
    }
    if (
      CHANNEL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      key === "TELEGRAM_BOT_TOKEN"
    ) {
      return true;
    }
  }
  return hasWhatsAppAuthState(env);
}

export function hasPotentialConfiguredChannels(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  if (channels) {
    for (const [key, value] of Object.entries(channels)) {
      if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
        continue;
      }
      if (recordHasKeys(value)) {
        return true;
      }
    }
  }
  return hasEnvConfiguredChannel(env);
}
