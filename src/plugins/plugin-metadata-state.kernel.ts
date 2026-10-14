import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { ConfigMachineStateDatabase } from "../state/config-machine-state-row.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";

export const INSTALLED_PLUGIN_INDEX_STATE_KEY = "plugins.installedIndex";

export type PluginMetadataStateSelector = "installed-index" | "bundled-discovery";
export type PluginMetadataStateKey =
  | typeof INSTALLED_PLUGIN_INDEX_STATE_KEY
  | "plugins.bundledDiscovery";
export type PluginMetadataStateRow = { state_key: string; value_json: string };

export function readPluginMetadataStateRowsInDatabase(
  db: DatabaseSync,
  stateKeys: readonly PluginMetadataStateKey[],
): PluginMetadataStateRow[] {
  if (!tableExists(db, "config_machine_state")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ConfigMachineStateDatabase>(db)
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json"])
      .where("state_key", "in", stateKeys),
  ).rows;
}
