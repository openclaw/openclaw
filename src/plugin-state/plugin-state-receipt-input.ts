import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { pluginStatePublicationKey } from "./plugin-state-publication.js";
import type { PluginStateWorkerOperations } from "./plugin-state-worker-contract.js";

/** References live only in the admission carrying this already serialized command. */
export function preparePluginStateReceiptInput(
  command: SqliteWorkerCommand<PluginStateWorkerOperations>,
): ReadonlyMap<string, string> | undefined {
  switch (command.type) {
    case "pluginState.register":
    case "pluginState.registerIfAbsent":
    case "pluginState.replaceEntry":
    case "pluginState.compareUpdate":
    case "pluginState.replace": {
      const input = command.input;
      const entries = "entries" in input ? input.entries : "valueJson" in input ? [input] : [];
      return new Map(
        entries.map((entry) => [
          pluginStatePublicationKey({
            plugin_id: input.pluginId,
            namespace: input.namespace,
            entry_key: entry.key,
          }),
          entry.valueJson,
        ]),
      );
    }
    default:
      return undefined;
  }
}
