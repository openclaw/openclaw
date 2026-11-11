import type { PluginCommandScheduleHost } from "../cron/plugin-command-schedule.types.js";
import { getPluginInstanceCodeIdentity } from "./plugin-code-identity.js";
import { listRegisteredPluginCommands } from "./plugin-command-registry.js";
import { getPluginInstanceIncarnation } from "./plugin-instance-scope.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";

/**
 * Loaded, enabled plugin instances of the current registry, with a code identity, that can serve
 * requester-command schedules, captured for the scheduler's claim. This only selects a re-arm
 * candidate: every occurrence still rechecks the live registry, plugin, code, command and
 * requester before dispatch.
 */
export function listPluginCommandScheduleHosts(
  registry: PluginRegistry | undefined,
): PluginCommandScheduleHost[] {
  if (!registry || isPluginRegistryRetired(registry)) {
    return [];
  }
  const commands = listRegisteredPluginCommands(registry);
  return registry.plugins.flatMap((plugin) => {
    const pluginIncarnation = getPluginInstanceIncarnation(plugin);
    if (
      !pluginIncarnation ||
      plugin.status !== "loaded" ||
      !plugin.enabled ||
      !plugin.contracts?.sessionScheduledTurns?.includes("requester-command")
    ) {
      return [];
    }
    // Without a code identity (captured source or the exact loaded build) nothing re-arms onto it.
    const sourceDigest = getPluginInstanceCodeIdentity(plugin);
    if (!sourceDigest) {
      return [];
    }
    return [
      {
        pluginId: plugin.id,
        pluginIncarnation,
        pluginSource: plugin.source,
        pluginRoot: plugin.rootDir,
        pluginVersion: plugin.version,
        sourceDigest,
        commands: commands
          .filter(
            (command) =>
              command.pluginId === plugin.id &&
              command.pluginRoot === plugin.rootDir &&
              command.requireAuth === true &&
              command.runtimeCapabilities?.includes("subagents"),
          )
          .map((command) => command.name),
      },
    ];
  });
}
