// Normalizes command-related config for slash and shell command handling.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only-command-defaults.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { NativeCommandsSetting } from "./types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type NativeCommandSettingParams = {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  autoDefault?: boolean;
};

/** Resolves native skill exposure for a provider, with provider config overriding global config. */
export function resolveNativeSkillsEnabled(params: NativeCommandSettingParams): boolean {
  return resolveNativeCommandSetting(params, "nativeSkills");
}

/** Resolves native command exposure for a provider, with provider config overriding global config. */
export function resolveNativeCommandsEnabled(params: NativeCommandSettingParams): boolean {
  return resolveNativeCommandSetting(params, "native");
}

function resolveNativeCommandSetting(
  params: NativeCommandSettingParams,
  kind: "native" | "nativeSkills",
): boolean {
  const { providerId, providerSetting, globalSetting, ...options } = params;
  const setting = providerSetting === undefined ? globalSetting : providerSetting;
  if (setting === true) {
    return true;
  }
  if (setting === false) {
    return false;
  }
  const id = normalizeChannelId(providerId) ?? normalizeOptionalLowercaseString(providerId);
  if (!id) {
    return false;
  }
  if (typeof options.autoDefault === "boolean") {
    return options.autoDefault;
  }
  // Prefer live plugin metadata; fall back to read-only manifest defaults during cold config paths.
  const commandDefaults =
    getLoadedChannelPlugin(id)?.commands ??
    (options.config
      ? resolveReadOnlyChannelCommandDefaults(id, {
          ...options,
          config: options.config,
        })
      : undefined);
  return kind === "native"
    ? commandDefaults?.nativeCommandsAutoEnabled === true
    : commandDefaults?.nativeSkillsAutoEnabled === true;
}

/** Returns true only when native commands are explicitly disabled by provider or inherited global config. */
export function isNativeCommandsExplicitlyDisabled(params: {
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  const { providerSetting, globalSetting } = params;
  if (providerSetting === false) {
    return true;
  }
  if (providerSetting === undefined) {
    return globalSetting === false;
  }
  return false;
}
