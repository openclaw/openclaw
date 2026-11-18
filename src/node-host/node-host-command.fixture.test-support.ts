import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginNodeHostCommandRegistration } from "../plugins/registry-types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";

type Command = PluginNodeHostCommandRegistration["command"];
export function registerCommands(
  ...commands: (Omit<Command, "handle"> & Partial<Pick<Command, "handle">>)[]
) {
  const registry = createEmptyPluginRegistry();
  registry.nodeHostCommands = commands.map((command) => ({
    pluginId: command.command.split(".")[0]!,
    source: "test",
    command: { handle: async () => "{}", ...command },
  }));
  registry.plugins = [...new Set(registry.nodeHostCommands.map(({ pluginId }) => pluginId))].map(
    (id) => createPluginRecord({ id, source: "test", origin: "bundled", configSchema: true }),
  );
  setActivePluginRegistry(registry);
  return registry;
}
