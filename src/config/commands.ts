import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { NativeCommandsSetting } from "./types.js";
export { isCommandFlagEnabled, isRestartEnabled, type CommandFlagKey } from "./commands.flags.js";

// Bundled channels with auto-enabled native commands/skills.
// Used as fallback during startup when plugin registry not yet populated.
const BUNDLED_AUTO_ENABLED = {
  telegram: { native: true, nativeSkills: true },
  discord: { native: true, nativeSkills: true },
} as const;

function resolveAutoDefault(
  providerId: ChannelId | undefined,
  kind: "native" | "nativeSkills",
): boolean {
  const id = normalizeChannelId(providerId);
  if (!id) {
    // Fallback for startup race: registry not yet populated when config loads.
    // Check against known bundled channels until registry initializes.
    const bundled = providerId ? BUNDLED_AUTO_ENABLED[providerId as keyof typeof BUNDLED_AUTO_ENABLED] : undefined;
    return bundled?.[kind] ?? false;
  }
  const plugin = getChannelPlugin(id);
  if (!plugin) {
    return false;
  }
  if (kind === "native") {
    return plugin.commands?.nativeCommandsAutoEnabled === true;
  }
  return plugin.commands?.nativeSkillsAutoEnabled === true;
}

export function resolveNativeSkillsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  return resolveNativeCommandSetting({ ...params, kind: "nativeSkills" });
}

export function resolveNativeCommandsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  return resolveNativeCommandSetting({ ...params, kind: "native" });
}

function resolveNativeCommandSetting(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
  kind?: "native" | "nativeSkills";
}): boolean {
  const { providerId, providerSetting, globalSetting, kind = "native" } = params;
  const setting = providerSetting === undefined ? globalSetting : providerSetting;
  if (setting === true) {
    return true;
  }
  if (setting === false) {
    return false;
  }
  return resolveAutoDefault(providerId, kind);
}

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
