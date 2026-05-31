import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginRegistrySnapshotSource } from "./plugin-registry-snapshot.types.js";

/** Deferred plugin-id scope resolved from the installed index at load time. */
export type PluginMetadataSnapshotPluginIdScope = {
  key: string;
  resolve: (params: { index: InstalledPluginIndex }) => readonly string[] | undefined;
};

/** Reverse lookup maps from manifest-owned surface ids to owning plugin ids. */
export type PluginMetadataSnapshotOwnerMaps = {
  channels: ReadonlyMap<string, readonly string[]>;
  channelConfigs: ReadonlyMap<string, readonly string[]>;
  providers: ReadonlyMap<string, readonly string[]>;
  modelCatalogProviders: ReadonlyMap<string, readonly string[]>;
  cliBackends: ReadonlyMap<string, readonly string[]>;
  setupProviders: ReadonlyMap<string, readonly string[]>;
  commandAliases: ReadonlyMap<string, readonly string[]>;
  contracts: ReadonlyMap<string, readonly string[]>;
};

/** Timings and counts captured while building a metadata snapshot. */
export type PluginMetadataSnapshotMetrics = {
  registrySnapshotMs: number;
  manifestRegistryMs: number;
  ownerMapsMs: number;
  totalMs: number;
  indexPluginCount: number;
  manifestPluginCount: number;
};

/** Non-fatal persisted registry state surfaced with metadata snapshots. */
export type PluginMetadataSnapshotRegistryDiagnostic = {
  level: "info" | "warn";
  code:
    | "persisted-registry-disabled"
    | "persisted-registry-missing"
    | "persisted-registry-stale-policy"
    | "persisted-registry-stale-source";
  message: string;
};

/** Immutable control-plane view of plugin manifests, ownership, and registry state. */
export type PluginMetadataSnapshot = {
  policyHash: string;
  configFingerprint?: string;
  pluginIds?: readonly string[];
  registrySource?: PluginRegistrySnapshotSource;
  workspaceDir?: string;
  index: InstalledPluginIndex;
  registryDiagnostics: readonly PluginMetadataSnapshotRegistryDiagnostic[];
  manifestRegistry: PluginManifestRegistry;
  plugins: readonly PluginManifestRecord[];
  diagnostics: readonly PluginDiagnostic[];
  byPluginId: ReadonlyMap<string, PluginManifestRecord>;
  normalizePluginId: (pluginId: string) => string;
  owners: PluginMetadataSnapshotOwnerMaps;
  metrics: PluginMetadataSnapshotMetrics;
  discovery?: PluginDiscoveryResult;
};

/** Narrow registry view for callers that only need index plus manifest registry. */
export type PluginMetadataRegistryView = Pick<PluginMetadataSnapshot, "index" | "manifestRegistry">;

/** Narrow manifest view for callers that only need loaded plugin records. */
export type PluginMetadataManifestView = Pick<PluginMetadataSnapshot, "index" | "plugins">;

/** Parameters that control metadata snapshot discovery, scope, and cache keys. */
export type LoadPluginMetadataSnapshotParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  index?: InstalledPluginIndex;
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
  preferPersisted?: boolean;
};

/** Snapshot resolve params, optionally allowing reuse of the current process slot. */
export type ResolvePluginMetadataSnapshotParams = LoadPluginMetadataSnapshotParams & {
  allowCurrent?: boolean;
  allowWorkspaceScopedCurrent?: boolean;
};
