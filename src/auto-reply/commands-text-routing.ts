import { listChannelPlugins } from "../channels/plugins/index.js";
import { getActivePluginChannelRegistryVersion } from "../plugins/runtime.js";
import type { ShouldHandleTextCommandsParams } from "./commands-registry.types.js";

let cachedNativeCommandSurfaces: Set<string> | null = null;
let cachedNativeCommandSurfacesVersion = -1;

export function isNativeCommandSurface(surface?: string): boolean {
  const normalized = surface?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const registryVersion = getActivePluginChannelRegistryVersion();
  if (!cachedNativeCommandSurfaces || cachedNativeCommandSurfacesVersion !== registryVersion) {
    cachedNativeCommandSurfaces = new Set(
      listChannelPlugins()
        .filter((plugin) => plugin.capabilities.nativeCommands)
        .map((plugin) => plugin.id),
    );
    cachedNativeCommandSurfacesVersion = registryVersion;
  }
  return cachedNativeCommandSurfaces.has(normalized);
}

export function shouldHandleTextCommands(params: ShouldHandleTextCommandsParams): boolean {
  if (params.commandSource === "native") {
    return true;
  }
  if (params.cfg.commands?.text !== false) {
    return true;
  }
  return !isNativeCommandSurface(params.surface);
}
