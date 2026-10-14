import type { DatabaseSync } from "node:sqlite";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import {
  INSTALLED_PLUGIN_INDEX_STATE_KEY,
  readPluginMetadataStateRowsInDatabase,
  type PluginMetadataStateKey,
  type PluginMetadataStateSelector,
} from "./plugin-metadata-state.kernel.js";

export const pluginMetadataReadOperations = {
  "plugins.metadata.read": (
    input:
      | { selector: PluginMetadataStateSelector }
      | { stateKeys: readonly PluginMetadataStateKey[] },
    database,
  ) => ({
    type: "plugins.metadata.read" as const,
    rows: readPluginMetadataStateRowsInDatabase(
      database,
      "stateKeys" in input
        ? input.stateKeys
        : [
            input.selector === "installed-index"
              ? INSTALLED_PLUGIN_INDEX_STATE_KEY
              : "plugins.bundledDiscovery",
          ],
    ),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;

export type PluginMetadataReadOperations = WorkerOperations<typeof pluginMetadataReadOperations>;
