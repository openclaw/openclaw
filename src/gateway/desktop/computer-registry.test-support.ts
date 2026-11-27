import {
  registerComputerUseProvider,
  type ComputerUseProvider,
} from "../../plugins/computer-use-registration.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";

export function createComputerRegistry(
  provider: ComputerUseProvider,
  options: {
    source?: string;
    origin?: Parameters<typeof createPluginRecord>[0]["origin"];
    configSchema?: boolean;
    pluginName?: string;
  } = {},
) {
  const { source = provider.id, origin = "bundled", configSchema = false } = options;
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    createPluginRecord({ id: provider.id, source, origin, enabled: true, configSchema }),
  );
  registerComputerUseProvider(
    {
      registerNodeHostCommand: (command) =>
        registry.nodeHostCommands.push({
          pluginId: provider.id,
          pluginName: options.pluginName ?? provider.label,
          command,
          source,
        }),
    },
    provider,
  );
  return registry;
}
