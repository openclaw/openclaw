import type { DatabaseSync } from "node:sqlite";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import {
  INSTALLED_PLUGIN_INDEX_STATE_KEY,
  readPluginMetadataStateRowsInDatabase,
  type PluginMetadataStateKey,
  type PluginMetadataStateRow,
  type PluginMetadataStateSelector,
} from "./plugin-metadata-state.kernel.js";

export {
  INSTALLED_PLUGIN_INDEX_STATE_KEY,
  readPluginMetadataStateRowsInDatabase,
  type PluginMetadataStateKey,
  type PluginMetadataStateRow,
  type PluginMetadataStateSelector,
} from "./plugin-metadata-state.kernel.js";

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
  stateKeys: readonly PluginMetadataStateKey[],
  databaseOptions: Parameters<typeof withExistingOpenClawStateDatabaseReadOnly>[1],
  artifactPreservingReadOnly = false,
): PluginMetadataStateRow[] {
  const read = ({ db }: { db: DatabaseSync }) =>
    readPluginMetadataStateRowsInDatabase(db, stateKeys);
  return (
    (artifactPreservingReadOnly
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, databaseOptions)
      : withExistingOpenClawStateDatabaseReadOnly(read, databaseOptions)) ?? []
  );
}
