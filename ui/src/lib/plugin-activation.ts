import {
  asNullableObjectRecord,
  asNullableRecord,
} from "@openclaw/normalization-core/record-coerce";
import type { ConfigSnapshot } from "../api/types.ts";

type PluginActivationOptions = {
  enabledByDefault?: boolean;
};

export function isPluginEnabledInConfigSnapshot(
  configSnapshot: ConfigSnapshot | null | undefined,
  pluginId: string,
  options?: PluginActivationOptions,
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

  const deny =
    Array.isArray(plugins?.deny) && plugins.deny.every((entry) => typeof entry === "string")
      ? plugins.deny
      : [];
  if (deny.includes(pluginId)) {
    return false;
  }

  const allow =
    Array.isArray(plugins?.allow) && plugins.allow.every((entry) => typeof entry === "string")
      ? plugins.allow
      : [];
  if (allow.length > 0 && !allow.includes(pluginId)) {
    return false;
  }

  const entries = asNullableObjectRecord(plugins?.entries);
  const enabled = asNullableRecord(entries?.[pluginId])?.enabled;
  return typeof enabled === "boolean" ? enabled : enabledByDefault;
}
