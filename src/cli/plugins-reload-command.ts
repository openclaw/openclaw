import type { PluginsReloadResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../runtime.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { resolvePluginLifecycleGateway } from "./plugins-lifecycle-client.js";

export type PluginsReloadOptions = { json?: boolean; acceptCapabilities?: boolean };

export async function runPluginsReloadCommand(
  ids: string[],
  opts: PluginsReloadOptions = {},
): Promise<void> {
  const pluginIds = [...new Set(ids)];
  const gateway = await resolvePluginLifecycleGateway();
  if (!gateway) {
    throw new Error("The Gateway is not running. Start it before reloading a plugin.");
  }
  const consent = resolvePluginCapabilityConsentCliOptions({
    ...opts,
    action: "reload",
    allowPrompt: !opts.json,
  });
  const result = await gateway<PluginsReloadResult>(
    "plugins.reload",
    { plugins: pluginIds.map((pluginId) => ({ pluginId })) },
    consent.onCapabilityConsent,
  );
  if (opts.json) {
    return defaultRuntime.writeJson(result);
  }
  for (const warning of result.warnings ?? []) {
    defaultRuntime.log(theme.warn(warning));
  }
  defaultRuntime.log(
    `Reloaded ${result.restartRequired ? "registrations for " : ""}${pluginIds.length === 1 ? "plugin" : "plugins"} ${pluginIds.map((id) => `"${id}"`).join(", ")} (generation ${result.runtime.generation}).${result.restartRequired ? " Gateway restart required to load edited code." : ""}`,
  );
}
