import type { PluginHostCleanupResult } from "./host-hook-cleanup.types.js";
import type {
  createPluginCacheArtifacts,
  createPluginRootArtifacts,
} from "./plugin-cache-artifacts.js";
import type {
  PluginDirectoryCacheEntry,
  PluginEntryCheck,
  PluginFileCacheEntry,
  PluginPathCacheEntry,
} from "./plugin-cache-files.types.js";
import type { PluginCacheManagement } from "./plugin-cache-management.js";
import type { PluginCacheMetadata } from "./plugin-cache-metadata.js";
import type { PluginCacheSdk } from "./plugin-cache-sdk.js";
import type { PluginInstanceResource, PluginModuleLoaderOwner } from "./plugin-instance.types.js";

export type PluginRootCacheRecord = ReturnType<typeof createPluginRootArtifacts> & {
  rootDir: string;
  files: Map<string, PluginFileCacheEntry>;
  checkedEntries: Map<string, PluginEntryCheck>;
  paths: Map<string, PluginPathCacheEntry>;
  directory?: PluginDirectoryCacheEntry;
};

export interface PluginCache
  extends
    PluginCacheMetadata,
    PluginCacheManagement<PluginCache>,
    ReturnType<typeof createPluginCacheArtifacts> {
  kind: "process" | "operation";
  roots: Map<string, PluginRootCacheRecord>;
  rootAliases: Map<string, string>;
  sdk: PluginCacheSdk;
  retireRegistryLoads?: () => Promise<PluginHostCleanupResult>;
  setupModules: Map<string, PluginModuleLoaderOwner>;
  instances: Set<PluginInstanceResource>;
  sourceAdmissions?: { invalidate(): void; dispose(): Promise<void> };
  retirement?: Promise<PluginHostCleanupResult>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type PluginCacheScope = { cache: PluginCache; parent?: PluginCacheScope };
