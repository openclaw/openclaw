import path from "node:path";
import { prepareBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { getPersistedInstalledPluginIndexCacheEntry } from "../plugins/installed-plugin-index-record-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  INSTALLED_PLUGIN_INDEX_STATE_KEY,
  readPluginMetadataStateRowsInDatabase,
} from "../plugins/plugin-metadata-state.kernel.js";
import { discoverBackupDatabasePaths } from "./backup-sqlite-snapshot.js";
import { inspectPhysicalStoreInProcess } from "./database-engine/physical-store-inspection.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import type { StateInput } from "./update-candidate-state.shared.js";
import { updateStateDatabaseExists } from "./update-candidate-state.sizes.js";

export async function discoverUpdateSupplementalDatabasePaths(
  input: StateInput,
): Promise<string[]> {
  const env = { ...input.env, OPENCLAW_STATE_DIR: input.stateDir };
  const params = { ...input, env, agentRegistry: [] };
  if (resolveDatabaseFamilyEngines(input.config).state === "postgres") {
    return discoverBackupDatabasePaths(params);
  }
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const rows = (await updateStateDatabaseExists(shared))
    ? await inspectPhysicalStoreInProcess(shared, false, (db) =>
        readPluginMetadataStateRowsInDatabase(db, [
          "plugins.bundledDiscovery",
          INSTALLED_PLUGIN_INDEX_STATE_KEY,
        ]),
      )
    : [];
  await using cache = createPluginCache();
  return await withPluginCache(cache, async () => {
    const activate = await prepareBundledDiscoveryMode(env, async () =>
      rows.find((row) => row.state_key === "plugins.bundledDiscovery"),
    );
    activate();
    getPersistedInstalledPluginIndexCacheEntry({ env, stateDir: input.stateDir }, () =>
      rows.find((row) => row.state_key === INSTALLED_PLUGIN_INDEX_STATE_KEY),
    );
    return discoverBackupDatabasePaths(params);
  });
}
