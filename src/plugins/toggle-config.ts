// Toggles plugin enablement config for channels and agents.
import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginConfigList } from "./config-normalization-shared.js";
import { mergePluginEntryAliases, normalizePluginId } from "./config-state.js";

/** Returns config with a plugin enabled/disabled and optional built-in channel state synced. */
export function setPluginEnabledInConfig(
  config: OpenClawConfig,
  pluginId: string,
  enabled: boolean,
  options: { updateChannelConfig?: boolean } = {},
): OpenClawConfig {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  const resolvedId = normalizePluginId(builtInChannelId ?? pluginId);
  const rawEntries = Object.entries(config.plugins?.entries ?? {});
  const existingEntry = mergePluginEntryAliases(config, resolvedId);

  const next: OpenClawConfig = {
    ...config,
    plugins: {
      ...config.plugins,
      ...(Array.isArray(config.plugins?.allow)
        ? { allow: normalizePluginConfigList(config.plugins.allow, normalizePluginId) }
        : {}),
      ...(Array.isArray(config.plugins?.deny)
        ? { deny: normalizePluginConfigList(config.plugins.deny, normalizePluginId) }
        : {}),
      entries: {
        ...Object.fromEntries(
          rawEntries.filter(([entryId]) => normalizePluginId(entryId) !== resolvedId),
        ),
        [resolvedId]: {
          ...existingEntry,
          enabled,
        },
      },
    },
  };

  if (!builtInChannelId || options.updateChannelConfig === false) {
    return next;
  }

  const channels = config.channels as Record<string, unknown> | undefined;
  const existing = channels?.[builtInChannelId];
  const existingRecord =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  return {
    ...next,
    channels: {
      ...config.channels,
      [builtInChannelId]: {
        ...existingRecord,
        enabled,
      },
    },
  };
}
