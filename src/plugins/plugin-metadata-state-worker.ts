import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import type {
  PluginMetadataStateKey,
  PluginMetadataStateRow,
  PluginMetadataStateSelector,
} from "./plugin-metadata-state.kernel.js";

async function readPluginMetadataState(
  selection:
    | { selector: PluginMetadataStateSelector }
    | { stateKeys: readonly PluginMetadataStateKey[] },
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly: boolean,
): Promise<PluginMetadataStateRow[]> {
  const stateKeys: PluginMetadataStateKey[] =
    "stateKeys" in selection
      ? [...selection.stateKeys]
      : [
          selection.selector === "installed-index"
            ? "plugins.installedIndex"
            : "plugins.bundledDiscovery",
        ];
  const read = () =>
    executeExistingOpenClawStateRead(
      options,
      {
        type: "plugins.metadata.read",
        input: { stateKeys },
      },
      { snapshotPreparation: "awaited" },
    );
  const result = await (artifactPreservingReadOnly
    ? withArtifactPreservingStateReads(read)
    : read());
  if (result === undefined) {
    return [];
  }
  return result.rows;
}

/** Read raw metadata through the shared reader, including retained snapshot scopes. */
export async function readPluginMetadataStateRow(
  selector: PluginMetadataStateSelector,
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly = false,
): Promise<{ value_json: string } | undefined> {
  const [row] = await readPluginMetadataState({ selector }, options, artifactPreservingReadOnly);
  return row ? { value_json: row.value_json } : undefined;
}

/** Policy and inventory preparation share one worker request and SQLite snapshot. */
export function readPluginMetadataStateRows(
  stateKeys: readonly PluginMetadataStateKey[],
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly = false,
): Promise<PluginMetadataStateRow[]> {
  return readPluginMetadataState({ stateKeys }, options, artifactPreservingReadOnly);
}
