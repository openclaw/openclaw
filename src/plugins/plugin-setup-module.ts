import { isMainThread } from "node:worker_threads";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import {
  getPluginCache,
  getPluginCacheRetirementSignal,
  retainPluginCache,
  retirePluginCacheInstance,
} from "./plugin-cache.js";
import type { PreparedPluginGenerationArtifact } from "./plugin-generation-worker.js";
import { isPluginSourceAcquisitionError } from "./plugin-instance-error.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { resolveBundledPluginStateOperationCapture } from "./plugin-state-operation-module-loader.js";

function setupKey(record: PluginManifestRecord, source: string, stateOperations?: false) {
  return `setup:${record.id}:${source}${stateOperations === false ? ":no-state-operations" : ""}`;
}

/** Setup callbacks belong to the inventory that loaded them. */
export function getPluginSetupModuleLoader(
  record: PluginManifestRecord,
  source: string,
  rootDir: string,
  options: {
    stateOperations?: false;
    preparedArtifact?: PreparedPluginGenerationArtifact;
  } = {},
) {
  const cache = getPluginCache();
  const key = setupKey(record, source, options.stateOperations);
  const cached = cache.setupModules.get(key);
  if (cached?.setupPreparationFailure) {
    throw cached.setupPreparationFailure;
  }
  if (!cached && cache.retirement) {
    throw new Error(`Plugin ${record.id} setup inventory has retired`);
  }
  const instance = cached ?? new PluginInstance(record.id, { cache });
  const discard = () => {
    // Repeated inspections share callbacks already published by successful initialization.
    if (instance.controlPlaneInitialized) {
      return;
    }
    // A retained failed loader cannot evict its replacement; the cache joins cleanup failures.
    if (cache.setupModules.get(key) === instance) {
      cache.setupModules.delete(key);
    }
    void retirePluginCacheInstance(instance, cache).catch(() => {});
  };
  const discardOnFailure = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      discard();
      throw error;
    }
  };
  if (!cached) {
    cache.setupModules.set(key, instance);
    discardOnFailure(() => {
      bindPluginInstanceModuleLoader({
        instance,
        origin: record.origin,
        source,
        rootDir,
        stateOperations: options.stateOperations,
        preparedArtifact: options.preparedArtifact,
      });
    });
  }
  return Object.assign((entry: string) => discardOnFailure(() => instance.loadModule(entry)), {
    initialize<T>(this: void, run: () => T): T {
      return discardOnFailure(() => {
        const result = run();
        instance.controlPlaneInitialized = true;
        return result;
      });
    },
  });
}

/** Keep setup selection, awaited preparation, and binding under the same cache authority. */
export async function withPluginSetupPreparation<T>(
  options: { assertCurrent?: () => void; signal?: AbortSignal },
  run: (scope: {
    cache: ReturnType<typeof getPluginCache>;
    assertCurrent: () => void;
  }) => Promise<T>,
): Promise<T> {
  const cache = getPluginCache();
  const metadata = cache.metadata;
  const signal = getAsyncWorkSignal();
  const retirement = getPluginCacheRetirementSignal(cache);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    options.signal?.throwIfAborted();
    retirement.throwIfAborted();
    options.assertCurrent?.();
    if (cache.retirement || getPluginCache() !== cache || cache.metadata !== metadata) {
      throw new Error("Plugin setup inventory has retired");
    }
  };
  assertCurrent();
  const release = retainPluginCache(cache);
  try {
    const result = await run({ cache, assertCurrent });
    assertCurrent();
    return result;
  } finally {
    release();
  }
}

/** Prepare source under the selected inventory, then bind callbacks only after authority is current. */
export async function preparePluginSetupModuleLoader(
  record: PluginManifestRecord,
  source: string,
  rootDir: string,
  options: { stateOperations?: false; assertCurrent?: () => void; signal?: AbortSignal } = {},
): Promise<void> {
  return await withPluginSetupPreparation(options, async ({ cache, assertCurrent }) => {
    const key = setupKey(record, source, options.stateOperations);
    if (cache.setupModules.has(key)) {
      return;
    }
    let prepared: PreparedPluginGenerationArtifact | undefined;
    try {
      const bundled = record.origin === "bundled";
      const capture =
        bundled && options.stateOperations !== false
          ? resolveBundledPluginStateOperationCapture({ rootDir, source })
          : undefined;
      if (!isMainThread || (bundled && !capture)) {
        getPluginSetupModuleLoader(record, source, rootDir, options);
        return;
      }
      const { preparePluginGenerationArtifact } = await import("./plugin-generation-worker.js");
      assertCurrent();
      prepared = await preparePluginGenerationArtifact(capture ?? { rootDir, source });
      assertCurrent();
      if (cache.setupModules.has(key)) {
        await prepared.artifact.disposeAsync();
        assertCurrent();
      } else {
        getPluginSetupModuleLoader(record, source, rootDir, {
          ...options,
          preparedArtifact: prepared,
        });
      }
      prepared = undefined;
    } catch (error) {
      if (prepared) {
        try {
          await prepared.artifact.disposeAsync();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Plugin setup preparation and cleanup failed",
            { cause: cleanupError },
          );
        }
      }
      assertCurrent();
      if (isPluginSourceAcquisitionError(error)) {
        if (!cache.setupModules.has(key)) {
          const failed = new PluginInstance(record.id, { cache });
          failed.setupPreparationFailure = error;
          cache.setupModules.set(key, failed);
        }
        return;
      }
      throw error;
    }
  });
}
