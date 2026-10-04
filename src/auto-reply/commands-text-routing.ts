/** Text-command routing decisions for surfaces that may also support native commands. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPluginById } from "../channels/plugins/registry-loaded.js";
import type { ShouldHandleTextCommandsParams } from "./commands-registry.types.js";

/** Decides whether text slash commands remain active for the current surface/config pair. */
export function shouldHandleTextCommands(params: ShouldHandleTextCommandsParams): boolean {
  if (params.commandSource === "native" || params.cfg.commands?.text !== false) {
    return true;
  }
  const surface = normalizeOptionalLowercaseString(params.surface);
  return !surface || getLoadedChannelPluginById(surface)?.capabilities?.nativeCommands !== true;
}
