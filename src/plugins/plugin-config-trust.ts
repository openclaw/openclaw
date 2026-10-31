import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

export function normalizePluginConfigId(id: unknown): string {
  return normalizeOptionalLowercaseString(id) ?? "";
}

export function hasPluginConfigId(list: unknown, pluginId: string): boolean {
  return Array.isArray(list) && list.some((entry) => normalizePluginConfigId(entry) === pluginId);
}

export function findPluginConfigEntry(
  entries: unknown,
  pluginId: string,
): Record<string, unknown> | undefined {
  if (!isRecord(entries)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(entries)) {
    if (normalizePluginConfigId(key) !== pluginId) {
      continue;
    }
    return isRecord(value) ? value : {};
  }
  return undefined;
}

/** Resolves whether workspace plugin config allows one plugin manifest record. */
export function isWorkspacePluginAllowedByConfig(params: {
  config: OpenClawConfig | undefined;
  isImplicitlyAllowed?: (pluginId: string) => boolean;
  plugin: PluginManifestRecord;
}): boolean {
  const pluginsConfig = params.config?.plugins;
  if (pluginsConfig?.enabled === false) {
    return false;
  }

  const pluginId = normalizePluginConfigId(params.plugin.id);
  if (!pluginId || hasPluginConfigId(pluginsConfig?.deny, pluginId)) {
    return false;
  }

  const entry = findPluginConfigEntry(pluginsConfig?.entries, pluginId);
  if (entry?.enabled === false) {
    return false;
  }
  if (entry?.enabled === true || hasPluginConfigId(pluginsConfig?.allow, pluginId)) {
    return true;
  }
  return params.isImplicitlyAllowed?.(pluginId) ?? false;
}
