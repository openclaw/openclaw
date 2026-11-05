import type { Command } from "commander";
import {
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "../plugins/install-config.js";

/** Commander resolves arguments and options before invoking pre-action hooks. */
export function resolvePluginInstallPreactionRequest(params: {
  actionCommand: Command;
  commandPath: string[];
}): PluginInstallRequestContext | null {
  if (params.commandPath[0] !== "plugins" || params.commandPath[1] !== "install") {
    return null;
  }
  const opts = params.actionCommand.opts<Record<string, unknown>>();
  const marketplace =
    typeof opts.marketplace === "string" ? opts.marketplace || undefined : undefined;
  const rawSpec =
    typeof params.actionCommand.processedArgs[0] === "string"
      ? params.actionCommand.processedArgs[0]
      : null;
  if (!rawSpec) {
    return null;
  }
  const request = resolvePluginInstallRequestContext({ rawSpec, marketplace });
  return request.ok ? request.request : null;
}
