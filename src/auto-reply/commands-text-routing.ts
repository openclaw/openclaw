import { getNativeCommandSurfaces } from "./commands-registry.data.js";
import type { ShouldHandleTextCommandsParams } from "./commands-registry.types.js";

export function isNativeCommandSurface(surface?: string): boolean {
  const normalized = surface?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return getNativeCommandSurfaces().has(normalized);
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
