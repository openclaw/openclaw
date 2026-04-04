import type { OpenClawConfig } from "../config/config.js";
import { listBundledChannelPlugins } from "./plugins/bundled.js";

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

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

function listConfiguredChannelEnvPrefixes(): Array<[prefix: string, channelId: string]> {
  return listBundledChannelPlugins().map((plugin) => [
    `${plugin.id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`,
    plugin.id,
  ]);
}

export function listPotentialConfiguredChannelIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configuredChannelIds = new Set<string>();
  const channelEnvPrefixes = listConfiguredChannelEnvPrefixes();
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
  for (const plugin of listBundledChannelPlugins()) {
    if (plugin.config?.hasPersistedAuthState?.({ cfg, env })) {
      configuredChannelIds.add(plugin.id);
    }
  }
  return [...configuredChannelIds];
}

function hasEnvConfiguredChannel(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  const channelEnvPrefixes = listConfiguredChannelEnvPrefixes();
  for (const [key, value] of Object.entries(env)) {
    if (!hasNonEmptyString(value)) {
      continue;
    }
    if (channelEnvPrefixes.some(([prefix]) => key.startsWith(prefix))) {
      return true;
    }
  }
  return listBundledChannelPlugins().some((plugin) =>
    Boolean(plugin.config?.hasPersistedAuthState?.({ cfg, env })),
  );
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
  return hasEnvConfiguredChannel(cfg ?? {}, env);
}
