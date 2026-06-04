import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { isInstalledPluginEnabled } from "../../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { ChannelPlugin } from "./types.plugin.js";

/**
 * Read-only command default resolution from installed plugin manifests.
 */

const SAFE_MANIFEST_CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Native command/skill auto-enable defaults exposed by channel manifests.
 */
export type ChannelCommandDefaults = Pick<
  NonNullable<ChannelPlugin["commands"]>,
  "nativeCommandsAutoEnabled" | "nativeSkillsAutoEnabled"
>;

type ManifestChannelConfigRecord = NonNullable<PluginManifestRecord["channelConfigs"]>[string];

type ReadOnlyChannelCommandRecord = {
  channelCatalogMeta?: {
    commands?: ChannelCommandDefaults;
    id: string;
  };
  channelConfigs?: Record<string, unknown>;
  channels: string[];
  id: string;
};

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

/**
 * Normalizes manifest command defaults down to supported boolean fields.
 */
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
    stateDir: options.stateDir,
    workspaceDir: options.workspaceDir,
    env,
    allowWorkspaceScopedCurrent: true,
  });
  for (const record of resolvedSnapshot.plugins) {
    const commandRecord = readOnlyChannelCommandRecord(record);
    if (!commandRecord?.channels.includes(normalizedChannelId)) {
      continue;
    }
    if (!isInstalledPluginEnabled(resolvedSnapshot.index, commandRecord.id, options.config)) {
      continue;
    }
    const commands = resolveCommandDefaultsFromRecord(commandRecord, normalizedChannelId);
    if (commands) {
      return commands;
    }
  }
  return undefined;
}

function readOnlyChannelCommandRecord(record: unknown): ReadOnlyChannelCommandRecord | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  try {
    const candidate = record as {
      channelCatalogMeta?: unknown;
      channelConfigs?: unknown;
      channels?: unknown;
      id?: unknown;
    };
    const { channelCatalogMeta, channelConfigs, channels, id } = candidate;
    if (typeof id !== "string" || id.length === 0) {
      return null;
    }
    if (!Array.isArray(channels)) {
      return null;
    }
    return {
      id,
      channels: channels.filter((channel): channel is string => typeof channel === "string"),
      ...(isRecord(channelConfigs) ? { channelConfigs } : {}),
      ...(isChannelCatalogMeta(channelCatalogMeta) ? { channelCatalogMeta } : {}),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChannelCatalogMeta(
  value: unknown,
): value is NonNullable<ReadOnlyChannelCommandRecord["channelCatalogMeta"]> {
  if (!isRecord(value)) {
    return false;
  }
  try {
    return typeof value.id === "string";
  } catch {
    return false;
  }
}

function resolveCommandDefaultsFromRecord(
  record: ReadOnlyChannelCommandRecord,
  normalizedChannelId: string,
): ChannelCommandDefaults | undefined {
  try {
    // Manifest channelConfigs are untrusted object data, so read the channel key
    // through the guarded helper instead of indexing directly.
    const channelConfigValue = record.channelConfigs
      ? readOwnRecordValue(record.channelConfigs, normalizedChannelId)
      : undefined;
    const channelConfig = isRecord(channelConfigValue)
      ? (channelConfigValue as ManifestChannelConfigRecord)
      : undefined;
    const catalogCommands =
      record.channelCatalogMeta?.id === normalizedChannelId
        ? record.channelCatalogMeta.commands
        : undefined;
    return normalizeChannelCommandDefaults(channelConfig?.commands ?? catalogCommands);
  } catch {
    return undefined;
  }
}
