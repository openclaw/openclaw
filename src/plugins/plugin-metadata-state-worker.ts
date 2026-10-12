import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import type {
  PluginMetadataStateKey,
  PluginMetadataStateRow,
  PluginMetadataStateSelector,
} from "./installed-plugin-index-row.js";
import { PluginCacheFactInvalidatedError } from "./plugin-cache.js";

/** Read raw metadata from retained snapshot bytes or the shared inspection worker. */
export async function readPluginMetadataStateRow(
  selector: PluginMetadataStateSelector,
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly = false,
): Promise<{ value_json: string } | undefined> {
  const rows = await readPluginMetadataStateRows(
    [selector === "installed-index" ? "plugins.installedIndex" : "plugins.bundledDiscovery"],
    options,
    artifactPreservingReadOnly,
  );
  return rows[0] ? { value_json: rows[0].value_json } : undefined;
}

/** Policy and inventory preparation share one worker request and SQLite snapshot. */
export async function readPluginMetadataStateRows(
  stateKeys: readonly PluginMetadataStateKey[],
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly = false,
): Promise<PluginMetadataStateRow[]> {
  const read = async () => {
    const result = await executeExistingOpenClawStateRead(options, {
      type: "plugins.metadata.read",
      input: { stateKeys: [...stateKeys] },
    });
    if (result === undefined) {
      return [];
    }
    if (result.ok && result.type === "plugins.metadata.read") {
      return result.rows;
    }
    throw new Error("Unexpected plugin metadata read reply");
  };
  try {
    return await (artifactPreservingReadOnly ? withArtifactPreservingStateReads(read) : read());
  } catch (error) {
    if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
      throw new PluginCacheFactInvalidatedError(
        "Plugin metadata read admission changed during preparation; retry the operation.",
        { cause: error },
      );
    }
    throw error;
  }
}
