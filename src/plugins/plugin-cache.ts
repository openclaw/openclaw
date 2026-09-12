import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginHostCleanupResult } from "./host-hook-cleanup.types.js";
import {
  createPluginCacheArtifacts,
  createPluginRootArtifacts,
  type PluginSourceCacheRecord,
} from "./plugin-cache-artifacts.js";
import type {
  PluginDirectoryCacheEntry,
  PluginEntryCheck,
  PluginFileCacheEntry,
  PluginPathCacheEntry,
} from "./plugin-cache-files.types.js";
import type { PluginCacheManagement } from "./plugin-cache-management.js";
import type { PluginCacheMetadata } from "./plugin-cache-metadata.js";
import { createPluginCacheSdk, type PluginCacheSdk } from "./plugin-cache-sdk.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
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
  retirement?: Promise<PluginHostCleanupResult>;
  [Symbol.asyncDispose](): Promise<void>;
}

type PluginCacheScope = { cache: PluginCache; parent?: PluginCacheScope };

const state = resolveGlobalSingleton<{
  current?: PluginCache;
  scope: AsyncLocalStorage<PluginCacheScope>;
  snapshotOwners: WeakMap<object, PluginCache>;
  retirements: Array<{
    cache: PluginCache;
    completion: Promise<PromiseSettledResult<PluginHostCleanupResult>>;
  }>;
}>(Symbol.for("openclaw.pluginCache"), () => ({
  scope: new AsyncLocalStorage<PluginCacheScope>(),
  snapshotOwners: new WeakMap(),
  retirements: [],
}));

const cacheRetainers = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginCacheRetainers"),
  () =>
    new WeakMap<
      PluginCache,
      {
        references: Set<object>;
        controller: AbortController;
        settled: ReturnType<typeof createDeferredCore<void>>;
        retirement?: Promise<PluginHostCleanupResult>;
      }
    >(),
);

function getPluginCacheRetainers(cache: PluginCache) {
  let retained = cacheRetainers.get(cache);
  if (!retained) {
    retained = {
      references: new Set(),
      controller: new AbortController(),
      settled: createDeferredCore(),
    };
    cacheRetainers.set(cache, retained);
  }
  return retained;
}

/** Cache retirement revokes cached publications before waiting for admitted borrowers. */
export function getPluginCacheRetirementSignal(cache: PluginCache): AbortSignal {
  return getPluginCacheRetainers(cache).controller.signal;
}

/** Admitted generations keep their exact prepared facts through publication replacement. */
export function retainPluginCache(cache: PluginCache): () => void {
  const retained = getPluginCacheRetainers(cache);
  if (cache.retirement || retained.retirement) {
    throw new Error("Plugin inventory has retired; begin a new plugin operation.");
  }
  if (retained.references.size === 0) {
    retained.settled = createDeferredCore();
  }
  const reference = {};
  retained.references.add(reference);
  return () => {
    if (retained.references.delete(reference) && retained.references.size === 0) {
      retained.settled.resolve();
    }
  };
}

export function getPluginCacheRetention(cache: PluginCache): Promise<void> | undefined {
  const retained = cacheRetainers.get(cache);
  return retained?.references.size ? retained.settled.promise : undefined;
}

function createPluginMetadataCache(): PluginCache["metadata"] {
  return {
    current: {
      snapshot: undefined,
      owner: "operation",
      configFingerprint: undefined,
      envFingerprint: undefined,
      defaultDiscoveryCompatible: false,
      compatiblePolicyHashes: undefined,
      compatibleConfigFingerprints: undefined,
      revision: Symbol("plugin-metadata-snapshot"),
      configIdentities: new WeakSet(),
    },
    snapshots: new Map(),
    discovery: new Map(),
    projections: new WeakMap(),
    projectionSources: new WeakMap(),
    completions: new WeakMap(),
    indexFacts: new WeakMap(),
    channelAdapters: new WeakMap(),
    bundledChannelCatalogs: new Map(),
    staticCatalogStates: new WeakMap(),
    modelSuppressionResolvers: new WeakMap(),
  };
}

/** Invalidate discovery facts without retiring callbacks owned by this operation. */
export function invalidatePluginCacheMetadata(cache: PluginCache): void {
  cache.metadata = createPluginMetadataCache();
  for (const root of cache.roots.values()) {
    root.files.clear();
    root.checkedEntries.clear();
    root.paths.clear();
    root.directory = undefined;
    root.artifacts.clear();
    root.runtimeArtifacts.clear();
    root.entryBoundaries.clear();
    root.entryPaths.clear();
  }
  cache.rootAliases.clear();
  cache.installRecords.clear();
  cache.persistedInstalledIndex.clear();
  cache.dependencyStatus = new WeakMap();
}

/** Each inventory owns its acquired facts and reusable load results; publication owns activation. */
export function createPluginCache(options: { kind?: PluginCache["kind"] } = {}): PluginCache {
  return {
    async [Symbol.asyncDispose]() {
      await retirePluginCache(this);
    },
    kind: options.kind ?? "operation",
    roots: new Map(),
    rootAliases: new Map(),
    sdk: createPluginCacheSdk(),
    setupModules: new Map(),
    instances: new Set(),
    metadata: createPluginMetadataCache(),
    installRecords: new Map(),
    persistedInstalledIndex: new Map(),
    dependencyStatus: new WeakMap(),
    ...createPluginCacheArtifacts(),
  };
}

export function getProcessPluginCache(): PluginCache {
  return (state.current ??= createPluginCache({ kind: "process" }));
}

/** Startup publishes its complete owner, including facts acquired before the kernel existed. */
export function adoptProcessPluginCache(cache: PluginCache): void {
  cache.kind = "process";
  state.current = cache;
}

export function getScopedPluginCache(): PluginCache | undefined {
  return state.scope.getStore()?.cache;
}

/** Installation refreshes every enclosing operation, including callers outside metadata phases. */
export function getScopedPluginCaches(): PluginCache[] {
  const caches: PluginCache[] = [];
  for (let scope = state.scope.getStore(); scope; scope = scope.parent) {
    caches.push(scope.cache);
  }
  return caches;
}

export function getPluginCache(): PluginCache {
  return getScopedPluginCache() ?? getProcessPluginCache();
}

export function withPluginCache<T>(cache: PluginCache, run: () => T): T {
  return state.scope.run({ cache, parent: state.scope.getStore() }, run);
}

export function runOutsidePluginCache<T>(run: () => T): T {
  return state.scope.exit(run);
}

/** Frozen views retain their producer so deferred access fills the same generation. */
export function bindPluginMetadataSnapshotCache(snapshot: object, cache = getPluginCache()): void {
  state.snapshotOwners.set(snapshot, cache);
}

export function getPluginMetadataSnapshotCache(snapshot: object): PluginCache {
  return state.snapshotOwners.get(snapshot) ?? getPluginCache();
}

/** Only the lifecycle owner retires the process cache; operation scopes remain independent. */
export function resetPluginCache(): void {
  const previous = state.current;
  state.current = undefined;
  if (previous) {
    // Public libraries refresh synchronously; managed instances keep their separate retirement.
    for (const source of previous.sources.values()) {
      source.disposeModule?.();
    }
    state.retirements.push({
      cache: previous,
      completion: retirePluginCache(previous).then(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      ),
    });
  }
}

/** Failed loaders retain their real completion under the cache that admitted them. */
export function retirePluginCacheInstance(
  instance: PluginInstanceResource,
  cache = getPluginCache(),
): Promise<void> {
  cache.instances.add(instance);
  // A registration caller may receive a self-retirement acknowledgment; this owner must join fully.
  const completion = pluginInstanceInvocation
    .exit(() => instance.dispose())
    .then((result) => {
      // Failed outcomes stay available to the cache's existing disposal aggregator.
      if (result.errors.length === 0) {
        cache.instances.delete(instance);
      }
    });
  void completion.catch(() => {});
  return completion;
}

/** Stop new setup calls immediately; the owner awaits in-flight calls and graph cleanup. */
export function retirePluginCache(
  cache: PluginCache,
  beforeRetire?: () => void,
): Promise<PluginHostCleanupResult> {
  const retained = getPluginCacheRetainers(cache);
  if (retained.retirement) {
    return retained.retirement;
  }
  const completion = createDeferredCore<PluginHostCleanupResult>();
  retained.retirement = completion.promise;
  // Abort listeners may reenter retirement or release the final generation immediately.
  retained.controller.abort();
  // Lazy error frames otherwise retain the retiring callback's scope after cleanup.
  try {
    void retained.controller.signal.reason.stack;
  } catch {
    // A custom stack formatter must not interrupt retirement.
  }
  const begin = () => beginPluginCacheRetirement(cache, beforeRetire);
  void (retained.references.size ? retained.settled.promise.then(begin) : begin()).then(
    completion.resolve,
    completion.reject,
  );
  return completion.promise;
}

function beginPluginCacheRetirement(
  cache: PluginCache,
  beforeRetire?: () => void,
): Promise<PluginHostCleanupResult> {
  if (cache.retirement) {
    return cache.retirement;
  }
  // Registry retirement can synchronously notify listeners; close admission before those callbacks.
  const retirement = createDeferredCore<PluginHostCleanupResult>();
  cache.retirement = retirement.promise;
  const cleanup = async () => {
    beforeRetire?.();
    const registries = cache.retireRegistryLoads?.();
    const resources = new Set([...cache.setupModules.values(), ...cache.instances]);
    for (const resource of resources) {
      resource.quiesce();
    }
    // Registry teardown owns host hooks before instance disposal; then join remaining cleanup.
    const [registry] = await Promise.allSettled([registries]);
    const outcomes = await Promise.allSettled(
      [...resources].map(async (resource) => ({ resource, result: await resource.dispose() })),
    );
    cache.setupModules.clear();
    cache.instances.clear();
    const unexpected = [
      ...(registry.status === "rejected" ? [registry.reason] : []),
      ...outcomes.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    if (unexpected.length) {
      throw new AggregateError(unexpected, "Plugin cache resources failed to retire");
    }
    const host = registry.status === "fulfilled" ? registry.value : undefined;
    const failures = [...(host?.failures ?? [])];
    for (const outcome of outcomes) {
      if (outcome.status !== "fulfilled") {
        continue;
      }
      const { resource, result } = outcome.value;
      for (const error of result.errors) {
        // A registry join may have already included this same instance's outcome.
        if (
          !failures.some(
            (failure) =>
              failure.pluginId === resource.pluginId &&
              failure.hookId === "instance" &&
              failure.error === error,
          )
        ) {
          failures.push({ pluginId: resource.pluginId, hookId: "instance", error });
        }
      }
    }
    return { cleanupCount: host?.cleanupCount ?? 0, failures };
  };
  void cleanup().then(retirement.resolve, retirement.reject);
  return retirement.promise;
}

/** Consume retirements initiated by synchronous config/setup cache invalidation. */
export async function waitForPluginCacheRetirement(
  includeBorrowed = false,
): Promise<PluginHostCleanupResult> {
  const ready = state.retirements.filter(
    ({ cache }) => includeBorrowed || cache.kind !== "process" || !getPluginCacheRetention(cache),
  );
  state.retirements = state.retirements.filter((retirement) => !ready.includes(retirement));
  const results = await Promise.all(ready.map((retirement) => retirement.completion));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "Plugin cache retirement failed");
  }
  const completed = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  return {
    cleanupCount: completed.reduce((count, result) => count + result.cleanupCount, 0),
    failures: completed.flatMap((result) => result.failures),
  };
}

export function getPluginCacheRoot(rootDir: string): PluginRootCacheRecord {
  const cache = getPluginCache();
  // Alias binding can replace the canonical record while older lexical records remain.
  const cached = cache.roots.get(cache.rootAliases.get(rootDir) ?? rootDir);
  if (cached) {
    return cached;
  }
  const lexical = path.resolve(rootDir);
  const key = cache.rootAliases.get(lexical) ?? lexical;
  let root = cache.roots.get(key);
  if (!root) {
    root = {
      rootDir: key,
      files: new Map(),
      checkedEntries: new Map(),
      paths: new Map(),
      ...createPluginRootArtifacts(),
    };
    cache.roots.set(key, root);
  }
  return root;
}

function mergeRootFacts<T>(target: Map<string, T>, source: Map<string, T>): void {
  for (const [key, value] of source) {
    if (!target.has(key)) {
      target.set(key, value);
    }
  }
}

/** Bind aliases only after a checked file establishes their shared package boundary. */
export function bindPluginCacheRoot(rootDir: string, canonicalRoot: string): PluginRootCacheRecord {
  const cache = getPluginCache();
  const lexical = path.resolve(rootDir);
  const canonical = path.resolve(canonicalRoot);
  const root = getPluginCacheRoot(lexical);
  root.rootDir = canonical;
  const existing = cache.roots.get(canonical);
  if (existing && existing !== root) {
    // Preserve the first checked facts while sharing maps with retained root references.
    mergeRootFacts(root.files, existing.files);
    mergeRootFacts(root.checkedEntries, existing.checkedEntries);
    mergeRootFacts(root.paths, existing.paths);
    mergeRootFacts(root.artifacts, existing.artifacts);
    mergeRootFacts(root.runtimeArtifacts, existing.runtimeArtifacts);
    mergeRootFacts(root.entryBoundaries, existing.entryBoundaries);
    mergeRootFacts(root.entryPaths, existing.entryPaths);
    root.directory ??= existing.directory;
    root.publicSurfaceBoundary ??= existing.publicSurfaceBoundary;
    for (const artifact of existing.artifactLoadsInProgress) {
      root.artifactLoadsInProgress.add(artifact);
    }
    Object.assign(existing, root);
  }
  cache.roots.set(canonical, root);
  cache.rootAliases.set(lexical, canonical);
  return root;
}

export function getPluginCacheSource(
  modulePath: string,
  cache = getPluginCache(),
): PluginSourceCacheRecord {
  const cached = cache.sources.get(cache.sourceAliases.get(modulePath) ?? modulePath);
  if (cached) {
    return cached;
  }
  const lexical = path.resolve(
    modulePath.startsWith("file:") ? fileURLToPath(modulePath) : modulePath,
  );
  const key = cache.sourceAliases.get(lexical) ?? lexical;
  let source = cache.sources.get(key);
  if (!source) {
    source = { variants: new Map(), validatedBoundaries: new Set() };
    cache.sources.set(key, source);
  }
  return source;
}
