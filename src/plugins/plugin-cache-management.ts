import type { PluginInstallRecordMapState } from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { OfficialCatalogResult } from "./official-external-plugin-catalog.types.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { PluginDependencyStatus } from "./status-dependencies.types.js";

export type PersistedInstalledPluginIndexCacheEntry = {
  state: { status: "missing" | "invalid" } | { status: "present"; value: unknown };
  records?: PluginInstallRecordMapState;
  index?: InstalledPluginIndex | null;
};

export type PluginCacheFact<T> = { value: T } | { pending: Promise<{ value: T }> };

type BundledDiscoveryModeFact = {
  value: "compat" | "allowlist" | undefined;
  generation: object;
};

export type PluginCacheManagement<TCache> = {
  installRecords: Map<string, Record<string, PluginInstallRecord>>;
  persistedInstalledIndex: Map<string, PluginCacheFact<PersistedInstalledPluginIndexCacheEntry>>;
  preparedBundledDiscoveryModes: Map<string, PluginCacheFact<BundledDiscoveryModeFact>>;
  desiredMetadata?: {
    boot: PluginMetadataSnapshot;
    cache: TCache;
    snapshot: PluginMetadataSnapshot;
  };
  dependencyStatus: WeakMap<PluginManifestRecord, PluginDependencyStatus>;
  officialCatalog?: Promise<OfficialCatalogResult>;
  pluginVersionCategories?: Map<string, Promise<Map<string, string[] | null>>>;
};
