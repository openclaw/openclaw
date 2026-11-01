import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPluginById } from "../channels/plugins/registry-loaded.js";
import type { ShouldHandleTextCommandsParams } from "./commands-registry.types.js";

export function shouldHandleTextCommands(params: ShouldHandleTextCommandsParams): boolean {
  if (params.commandSource === "native" || params.cfg.commands?.text !== false) {
    return true;
  }
  const surface = normalizeOptionalLowercaseString(params.surface);
  return !surface || getLoadedChannelPluginById(surface)?.capabilities?.nativeCommands !== true;
}
