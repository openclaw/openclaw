import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir, STATE_DIR } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { isInstalledPluginEnabled } from "../../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { ChannelPlugin } from "./types.plugin.js";

const SAFE_MANIFEST_CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

type ChannelCommandDefaults = Pick<
  NonNullable<ChannelPlugin["commands"]>,
  "nativeCommandsAutoEnabled" | "nativeSkillsAutoEnabled"
>;

type ManifestChannelConfigRecord = NonNullable<PluginManifestRecord["channelConfigs"]>[string];

/**
 * Returns whether a manifest channel id is safe for own-property lookup.
 */
export function isSafeManifestChannelId(channelId: string): boolean {
  return SAFE_MANIFEST_CHANNEL_ID_PATTERN.test(channelId) && !isBlockedObjectKey(channelId);
}

/**
 * Reads an own record property while blocking prototype-polluting keys.
 */
export function readOwnRecordValue(record: Record<string, unknown>, key: string): unknown {
  if (isBlockedObjectKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return record[key];
}

export function normalizeChannelCommandDefaults(
  value: ChannelCommandDefaults | undefined,
): ChannelCommandDefaults | undefined {
  if (!value) {
    return undefined;
  }
  const defaults: ChannelCommandDefaults = {};
  for (const key of ["nativeCommandsAutoEnabled", "nativeSkillsAutoEnabled"] as const) {
    if (typeof value[key] === "boolean") {
      defaults[key] = value[key];
    }
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

/**
 * Resolves command defaults from enabled installed plugin metadata without loading plugins.
 */
export function resolveReadOnlyChannelCommandDefaults(
  channelId: string,
  options: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    workspaceDir?: string;
    config: OpenClawConfig;
  },
): ChannelCommandDefaults | undefined {
  const normalizedChannelId = normalizeOptionalString(channelId) ?? "";
  if (!normalizedChannelId || !isSafeManifestChannelId(normalizedChannelId)) {
    return undefined;
  }
  const env = options.env ?? process.env;
  const resolvedSnapshot = resolvePluginMetadataSnapshot({
    config: options.config,
    stateDir:
      options.stateDir !== undefined &&
      options.stateDir === (env === process.env ? STATE_DIR : resolveStateDir(env))
        ? undefined
        : options.stateDir,
    workspaceDir: options.workspaceDir,
    env,
    allowWorkspaceScopedCurrent: true,
  });
  for (const record of resolvedSnapshot.plugins) {
    if (!record.channels.includes(normalizedChannelId)) {
      continue;
    }
    if (!isInstalledPluginEnabled(resolvedSnapshot.index, record.id, options.config)) {
      continue;
    }
    // Manifest channelConfigs are untrusted object data, so read the channel key
    // through the guarded helper instead of indexing directly.
    const channelConfigValue = record.channelConfigs
      ? readOwnRecordValue(record.channelConfigs as Record<string, unknown>, normalizedChannelId)
      : undefined;
    const channelConfig =
      channelConfigValue &&
      typeof channelConfigValue === "object" &&
      !Array.isArray(channelConfigValue)
        ? (channelConfigValue as ManifestChannelConfigRecord)
        : undefined;
    const catalogCommands =
      record.channelCatalogMeta?.id === normalizedChannelId
        ? record.channelCatalogMeta.commands
        : undefined;
    const commands = normalizeChannelCommandDefaults(channelConfig?.commands ?? catalogCommands);
    if (commands) {
      return commands;
    }
  }
  return undefined;
}
