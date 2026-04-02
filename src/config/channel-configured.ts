import { hasMeaningfulChannelConfig } from "../channels/config-presence.js";
import { hasAnyWhatsAppAuth } from "../plugin-sdk/whatsapp-auth-presence.js";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./config.js";

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function accountsHaveKeys(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) {
    return false;
  }
  for (const account of Object.values(value)) {
    if (!isRecord(account)) {
      continue;
    }
    for (const key of keys) {
      if (hasNonEmptyString(account[key])) {
        return true;
      }
    }
  }
  return false;
}

function resolveChannelConfig(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  return isRecord(entry) ? entry : null;
}

type StructuredChannelConfigSpec = {
  envAny?: readonly string[];
  envAll?: readonly string[];
  stringKeys?: readonly string[];
  numberKeys?: readonly string[];
  accountStringKeys?: readonly string[];
};

const STRUCTURED_CHANNEL_CONFIG_SPECS: Record<string, StructuredChannelConfigSpec> = {
  telegram: {
    envAny: ["TELEGRAM_BOT_TOKEN"],
    stringKeys: ["botToken", "tokenFile"],
    accountStringKeys: ["botToken", "tokenFile"],
  },
  discord: {
    envAny: ["DISCORD_BOT_TOKEN"],
    stringKeys: ["token"],
    accountStringKeys: ["token"],
  },
  irc: {
    envAll: ["IRC_HOST", "IRC_NICK"],
    stringKeys: ["host", "nick"],
    accountStringKeys: ["host", "nick"],
  },
  slack: {
    envAny: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
    stringKeys: ["botToken", "appToken", "userToken"],
    accountStringKeys: ["botToken", "appToken", "userToken"],
  },
  signal: {
    stringKeys: ["account", "httpUrl", "httpHost", "cliPath"],
    numberKeys: ["httpPort"],
    accountStringKeys: ["account", "httpUrl", "httpHost", "cliPath"],
  },
  imessage: {
    stringKeys: ["cliPath"],
  },
};

function envHasAnyKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (hasNonEmptyString(env[key])) {
      return true;
    }
  }
  return false;
}

function envHasAllKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (!hasNonEmptyString(env[key])) {
      return false;
    }
  }
  return keys.length > 0;
}

function hasAnyNumberKeys(entry: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (typeof entry[key] === "number") {
      return true;
    }
  }
  return false;
}

function isStructuredChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv,
  spec: StructuredChannelConfigSpec,
): boolean {
  if (spec.envAny && envHasAnyKeys(env, spec.envAny)) {
    return true;
  }
  if (spec.envAll && envHasAllKeys(env, spec.envAll)) {
    return true;
  }
  const entry = resolveChannelConfig(cfg, channelId);
  if (!entry) {
    return false;
  }
  if (spec.stringKeys && spec.stringKeys.some((key) => hasNonEmptyString(entry[key]))) {
    return true;
  }
  if (spec.numberKeys && hasAnyNumberKeys(entry, spec.numberKeys)) {
    return true;
  }
  if (spec.accountStringKeys && accountsHaveKeys(entry.accounts, spec.accountStringKeys)) {
    return true;
  }
  return hasMeaningfulChannelConfig(entry);
}

function isWhatsAppConfigured(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (hasAnyWhatsAppAuth(cfg, env)) {
    return true;
  }
  const entry = resolveChannelConfig(cfg, "whatsapp");
  if (!entry) {
    return false;
  }
  return hasMeaningfulChannelConfig(entry);
}

function isGenericChannelConfigured(cfg: OpenClawConfig, channelId: string): boolean {
  const entry = resolveChannelConfig(cfg, channelId);
  return hasMeaningfulChannelConfig(entry);
}

export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (channelId === "whatsapp") {
    return isWhatsAppConfigured(cfg, env);
  }
  const spec = STRUCTURED_CHANNEL_CONFIG_SPECS[channelId];
  if (spec) {
    return isStructuredChannelConfigured(cfg, channelId, env, spec);
  }
  return isGenericChannelConfigured(cfg, channelId);
}
