import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import {
  inspectPluginInstallRecordMap,
  type PluginInstallRecordMapState,
} from "../config/plugin-install-record-map.js";
import {
  readBundledDiscoveryMode,
  readBundledDiscoveryModeMemoized,
} from "./bundled-discovery-state.js";
import {
  INSTALLED_PLUGIN_INDEX_STATE_KEY,
  readPluginMetadataStateRowSync,
  readPluginMetadataStateRowsSync,
} from "./installed-plugin-index-row.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import type { PersistedInstalledPluginIndexCacheEntry } from "./plugin-cache-management.js";
import { getPluginCache, preparePluginCacheFact } from "./plugin-cache.js";
import { readPluginMetadataStateRow } from "./plugin-metadata-state-worker.js";

/** Read failures must escape before either projection can authorize recovery or rebuilding. */
export function readPersistedInstalledPluginIndexRowSync(
  options: InstalledPluginIndexStoreOptions,
): { value_json: string } | undefined {
  if (options.filePath?.endsWith(".json")) {
    return undefined;
  }
  return readPluginMetadataStateRowSync(
    "installed-index",
    resolveInstalledPluginIndexStateDatabaseOptions(options),
    options.artifactPreservingReadOnly,
  );
}

/** Share the SQLite row while validating install records independently from index metadata. */
export function getPersistedInstalledPluginIndexCacheEntry(
  options: InstalledPluginIndexStoreOptions,
  readRow: () => { value_json: string } | undefined = () =>
    readPersistedInstalledPluginIndexRowSync(options),
): PersistedInstalledPluginIndexCacheEntry {
  const cache = getPluginCache().persistedInstalledIndex;
  const key = path.resolve(resolveInstalledPluginIndexStorePath(options));
  const current = cache.get(key);
  if (current && "value" in current) {
    return current.value;
  }
  // The row reader owns unreadable-state failures; never cache them as missing or invalid.
  const row = readRow();
  const entry: PersistedInstalledPluginIndexCacheEntry = {
    state: row
      ? { status: "present", value: safeParseJson(row.value_json) }
      : { status: "missing" },
  };
  cache.set(key, { value: entry });
  return entry;
}

/** Prepare missing policy and inventory facts without replacing their lifecycle owners. */
export function preparePluginMetadataMachineState(options: InstalledPluginIndexStoreOptions): void {
  const env = options.env ?? process.env;
  readBundledDiscoveryModeMemoized(env, options, (databasePath) => {
    const key = path.resolve(resolveInstalledPluginIndexStorePath(options));
    const current = getPluginCache().persistedInstalledIndex.get(key);
    if (
      path.resolve(databasePath) !== key ||
      options.filePath?.endsWith(".json") ||
      (current && "value" in current)
    ) {
      return readBundledDiscoveryMode({ env }, options);
    }
    const rows = readPluginMetadataStateRowsSync(
      ["plugins.bundledDiscovery", INSTALLED_PLUGIN_INDEX_STATE_KEY],
      resolveInstalledPluginIndexStateDatabaseOptions(options),
      options.artifactPreservingReadOnly,
    );
    const mode = rows.find((row) => row.state_key === "plugins.bundledDiscovery");
    const value: unknown = mode ? JSON.parse(mode.value_json) : undefined;
    getPersistedInstalledPluginIndexCacheEntry(options, () =>
      rows.find((row) => row.state_key === INSTALLED_PLUGIN_INDEX_STATE_KEY),
    );
    return value;
  });
}

/** Await one shared row, retaining its cache generation until publication completes. */
export async function preparePersistedInstalledPluginIndexCacheEntry(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<{ entry: PersistedInstalledPluginIndexCacheEntry; assertCurrent: () => void }> {
  const owner = getPluginCache();
  const key = path.resolve(resolveInstalledPluginIndexStorePath(options));
  const databaseOptions = resolveInstalledPluginIndexStateDatabaseOptions(options);
  const prepared = await preparePluginCacheFact(
    owner,
    owner.persistedInstalledIndex,
    key,
    async () => {
      const row = options.filePath?.endsWith(".json")
        ? undefined
        : await readPluginMetadataStateRow(
            "installed-index",
            databaseOptions,
            options.artifactPreservingReadOnly,
          );
      return {
        state: row
          ? { status: "present", value: safeParseJson(row.value_json) }
          : { status: "missing" },
      } satisfies PersistedInstalledPluginIndexCacheEntry;
    },
  );
  return { entry: prepared.value, assertCurrent: prepared.assertCurrent };
}

export function inspectPersistedInstalledPluginIndexInstallRecords(
  entry: PersistedInstalledPluginIndexCacheEntry,
): PluginInstallRecordMapState {
  if (!entry.records) {
    const state = entry.state;
    // The full index can be invalid while its canonical install ledger remains usable.
    const value = state.status === "present" ? state.value : undefined;
    const records = (value as { index?: { installRecords?: unknown } } | undefined)?.index
      ?.installRecords;
    entry.records =
      state.status === "missing"
        ? { status: "missing" }
        : records === undefined
          ? { status: "invalid" }
          : inspectPluginInstallRecordMap(records);
  }
  return entry.records;
}

export function inspectPersistedInstalledPluginIndexInstallRecordsSync(
  options: InstalledPluginIndexStoreOptions = {},
): PluginInstallRecordMapState {
  return inspectPersistedInstalledPluginIndexInstallRecords(
    getPersistedInstalledPluginIndexCacheEntry(options),
  );
}
