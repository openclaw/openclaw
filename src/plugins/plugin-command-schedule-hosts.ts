import type { PluginCommandScheduleHost } from "../cron/plugin-command-schedule.types.js";
import { listRegisteredPluginCommands } from "./plugin-command-registry.js";
import {
  getPluginInstanceIncarnation,
  getPluginInstanceSourceDigest,
} from "./plugin-instance-scope.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";

/**
 * Loaded, enabled plugin instances of the current registry, with captured source, that can serve
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
    // Without captured source there is no code identity to match, so nothing re-arms onto it.
    const sourceDigest = getPluginInstanceSourceDigest(plugin);
    if (
      !pluginIncarnation ||
      !sourceDigest ||
      plugin.status !== "loaded" ||
      !plugin.enabled ||
      !plugin.contracts?.sessionScheduledTurns?.includes("requester-command")
    ) {
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
