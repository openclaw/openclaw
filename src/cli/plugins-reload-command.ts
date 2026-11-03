import { randomUUID } from "node:crypto";
import type { PluginsReloadResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatSelectedEntry } from "../plugins/reload-entry-guidance.js";
import { defaultRuntime } from "../runtime.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { resolvePluginLifecycleGateway } from "./plugins-lifecycle-client.js";

export type PluginsReloadOptions = {
  json?: boolean;
  acceptCapabilities?: boolean;
  wait?: boolean;
  force?: boolean;
  operationId?: string;
};

export async function runPluginsReloadCommand(
  ids: string[],
  opts: PluginsReloadOptions = {},
): Promise<void> {
  if (opts.operationId && !opts.force) {
    throw new Error("--operation-id requires --force.");
  }
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
    {
      plugins: pluginIds.map((pluginId) => ({ pluginId })),
      ...(opts.wait ? { waitForDrain: true } : {}),
      ...(opts.force ? { force: true, operationId: opts.operationId ?? randomUUID() } : {}),
    },
    consent.onCapabilityConsent,
  );
  if (opts.json) {
    return defaultRuntime.writeJson(result);
  }
  if (result.status === "accepted") {
    defaultRuntime.log(
      terminalText`Plugin reload ${result.operationId} accepted by the Gateway. The operation continues if this observer disconnects.`,
    );
    return;
  }
  for (const warning of result.warnings ?? []) {
    defaultRuntime.log(theme.warn(terminalText`${warning}`));
  }
  for (const [id, entry] of Object.entries(result.runtime.selectedEntries ?? {})) {
    defaultRuntime.log(terminalText`${id}: ${formatSelectedEntry(entry)}`);
  }
  defaultRuntime.log(
    terminalText`Reloaded ${result.restartRequired ? "registrations for " : ""}${pluginIds.length === 1 ? "plugin" : "plugins"} ${pluginIds.map((id) => `"${id}"`).join(", ")} (generation ${result.runtime.generation}).${result.restartRequired ? " Gateway restart required to load edited code." : ""}`,
  );
}
