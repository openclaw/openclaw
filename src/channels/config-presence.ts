import fs from "node:fs";
import os from "node:os";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { getBootstrapChannelPlugin } from "./plugins/bootstrap-registry.js";
import { listBundledChannelPluginIds } from "./plugins/bundled-ids.js";

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

type ChannelPresenceOptions = {
  includePersistedAuthState?: boolean;
};

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

function listChannelEnvPrefixes(
  channelIds: readonly string[],
): Array<[prefix: string, channelId: string]> {
  return channelIds.map((channelId) => [
    `${channelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`,
    channelId,
  ]);
}

function hasPersistedChannelState(env: NodeJS.ProcessEnv): boolean {
  return fs.existsSync(resolveStateDir(env, os.homedir));
}

export function listPotentialConfiguredChannelIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: ChannelPresenceOptions = {},
): string[] {
  const configuredChannelIds = new Set<string>();
  const channelIds = listBundledChannelPluginIds();
  const channelEnvPrefixes = listChannelEnvPrefixes(channelIds);
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
    for (const [prefix, channelId] of channelEnvPrefixes) {
      if (key.startsWith(prefix)) {
        configuredChannelIds.add(channelId);
      }
    }
  }

  if (options.includePersistedAuthState !== false && hasPersistedChannelState(env)) {
    for (const channelId of channelIds) {
      const plugin = getBootstrapChannelPlugin(channelId);
      if (plugin?.config?.hasPersistedAuthState?.({ cfg, env })) {
        configuredChannelIds.add(channelId);
      }
    }
  }

  return [...configuredChannelIds];
}

function hasEnvConfiguredChannel(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  options: ChannelPresenceOptions = {},
): boolean {
  const channelIds = listBundledChannelPluginIds();
  const channelEnvPrefixes = listChannelEnvPrefixes(channelIds);
  for (const [key, value] of Object.entries(env)) {
    if (!hasNonEmptyString(value)) {
      continue;
    }
    if (channelEnvPrefixes.some(([prefix]) => key.startsWith(prefix))) {
      return true;
    }
  }
  if (options.includePersistedAuthState === false || !hasPersistedChannelState(env)) {
    return false;
  }
  return channelIds.some((channelId) =>
    Boolean(getBootstrapChannelPlugin(channelId)?.config?.hasPersistedAuthState?.({ cfg, env })),
  );
}

export function hasPotentialConfiguredChannels(
  cfg: OpenClawConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: ChannelPresenceOptions = {},
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
  return hasEnvConfiguredChannel(cfg ?? {}, env, options);
}
