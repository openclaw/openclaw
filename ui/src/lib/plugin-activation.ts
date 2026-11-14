import {
  asNullableObjectRecord,
  asNullableRecord,
  isStringArray,
} from "@openclaw/normalization-core/record-coerce";
import type { ConfigSnapshot } from "../api/types.ts";

export function isPluginEnabledInConfigSnapshot(
  configSnapshot: ConfigSnapshot | null | undefined,
  pluginId: string,
  options?: {
    enabledByDefault?: boolean;
  },
): boolean {
  const enabledByDefault = options?.enabledByDefault ?? true;
  const config = asNullableRecord(configSnapshot?.config);
  if (!config) {
    return enabledByDefault;
  }

  const plugins = asNullableObjectRecord(config.plugins);
  if (plugins?.enabled === false) {
    return false;
  }

  const deny = isStringArray(plugins?.deny) ? plugins.deny : [];
  if (deny.includes(pluginId)) {
    return false;
  }

  const allow = isStringArray(plugins?.allow) ? plugins.allow : [];
  if (allow.length > 0 && !allow.includes(pluginId)) {
    return false;
  }

  const entries = asNullableObjectRecord(plugins?.entries);
  const enabled = asNullableRecord(entries?.[pluginId])?.enabled;
  return typeof enabled === "boolean" ? enabled : enabledByDefault;
}
