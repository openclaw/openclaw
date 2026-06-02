import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { isInstalledPluginEnabled } from "../../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { ChannelPlugin } from "./types.plugin.js";

const SAFE_MANIFEST_CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Native command defaults that can be resolved without plugin activation. */
export type ChannelCommandDefaults = Pick<
  NonNullable<ChannelPlugin["commands"]>,
  "nativeCommandsAutoEnabled" | "nativeSkillsAutoEnabled"
>;

type ManifestChannelConfigRecord = NonNullable<PluginManifestRecord["channelConfigs"]>[string];

/** Accepts manifest channel ids that are safe to use as own-property keys. */
export function isSafeManifestChannelId(channelId: string): boolean {
  return SAFE_MANIFEST_CHANNEL_ID_PATTERN.test(channelId) && !isBlockedObjectKey(channelId);
}

/** Reads a manifest/config record key without traversing prototype pollution keys. */
export function readOwnRecordValue(record: Record<string, unknown>, key: string): unknown {
  if (isBlockedObjectKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return record[key];
}

/** Normalizes optional command defaults from manifest metadata. */
export function normalizeChannelCommandDefaults(
  value: ChannelCommandDefaults | undefined,
): ChannelCommandDefaults | undefined {
  if (!value) {
    return undefined;
  }
  const nativeCommandsAutoEnabled =
    typeof value.nativeCommandsAutoEnabled === "boolean"
      ? value.nativeCommandsAutoEnabled
      : undefined;
  const nativeSkillsAutoEnabled =
    typeof value.nativeSkillsAutoEnabled === "boolean" ? value.nativeSkillsAutoEnabled : undefined;
  if (nativeCommandsAutoEnabled === undefined && nativeSkillsAutoEnabled === undefined) {
    return undefined;
  }
  const defaults: ChannelCommandDefaults = {};
  if (nativeCommandsAutoEnabled !== undefined) {
    defaults.nativeCommandsAutoEnabled = nativeCommandsAutoEnabled;
  }
  if (nativeSkillsAutoEnabled !== undefined) {
    defaults.nativeSkillsAutoEnabled = nativeSkillsAutoEnabled;
  }
  return defaults;
}

/**
 * Resolves read-only native command defaults from plugin metadata snapshots
 * without loading the channel plugin implementation.
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
    stateDir: options.stateDir,
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
