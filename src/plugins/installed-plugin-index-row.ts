import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { ConfigMachineStateDatabase } from "../state/config-machine-state.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";

export const INSTALLED_PLUGIN_INDEX_STATE_KEY = "plugins.installedIndex";

export type PluginMetadataStateSelector = "installed-index" | "bundled-discovery";

/** Shared inspection commands use the same existing-only, artifact-preserving reader. */
export function readPluginMetadataStateRowSync(
  selector: PluginMetadataStateSelector,
  databaseOptions: Parameters<typeof withExistingOpenClawStateDatabaseReadOnly>[1],
  artifactPreservingReadOnly = false,
): { value_json: string } | undefined {
  const row = readPluginMetadataStateRowsSync(
    [
      selector === "installed-index"
        ? INSTALLED_PLUGIN_INDEX_STATE_KEY
        : "plugins.bundledDiscovery",
    ],
    databaseOptions,
    artifactPreservingReadOnly,
  )[0];
  return row ? { value_json: row.value_json } : undefined;
}

/** Acquire related metadata facts from the same prepared database bytes. */
export function readPluginMetadataStateRowsSync(
  stateKeys: readonly (typeof INSTALLED_PLUGIN_INDEX_STATE_KEY | "plugins.bundledDiscovery")[],
  databaseOptions: Parameters<typeof withExistingOpenClawStateDatabaseReadOnly>[1],
  artifactPreservingReadOnly = false,
): { state_key: string; value_json: string }[] {
  const read = ({ db }: { db: DatabaseSync }) => {
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
  };
  return (
    (artifactPreservingReadOnly
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, databaseOptions)
      : withExistingOpenClawStateDatabaseReadOnly(read, databaseOptions)) ?? []
  );
}
