import type { Command } from "commander";
import {
  resolvePluginInstallInvalidConfigPolicy,
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "../plugins/install-config.js";

/** Commander resolves arguments and options before invoking pre-action hooks. */
export function resolvePluginInstallPreactionRequest(
  actionCommand: Command,
): PluginInstallRequestContext | null {
  const opts = actionCommand.opts<Record<string, unknown>>();
  const marketplace =
    typeof opts.marketplace === "string" ? opts.marketplace || undefined : undefined;
  const rawSpec =
    typeof actionCommand.processedArgs[0] === "string" ? actionCommand.processedArgs[0] : null;
  if (!rawSpec) {
    return null;
  }
  const request = resolvePluginInstallRequestContext({ rawSpec, marketplace });
  return request.ok ? request.request : null;
}

export function allowsPluginInstallConfigRecovery(actionCommand: Command): boolean {
  return (
    resolvePluginInstallInvalidConfigPolicy(resolvePluginInstallPreactionRequest(actionCommand)) ===
    "allow-plugin-recovery"
  );
}
