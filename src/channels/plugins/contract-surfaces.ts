import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { discoverOpenClawPlugins } from "../../plugins/discovery.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "../../plugins/sdk-alias.js";

const CONTRACT_BASENAME = "contract-api.ts";

let cachedSurfaces: unknown[] | null = null;
let cachedSurfaceEntries: Array<{
  pluginId: string;
  surface: unknown;
}> | null = null;
let contractSurfacesLoading = false;

const EMPTY_CONTRACT_SURFACE_ENTRIES: Array<{ pluginId: string; surface: unknown }> = [];

function createModuleLoader() {
  const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();
  return (modulePath: string) => {
    const tryNative = shouldPreferNativeJiti(modulePath);
    const aliasMap = buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url);
    const cacheKey = JSON.stringify({
      tryNative,
      aliasMap: Object.entries(aliasMap).toSorted(([a], [b]) => a.localeCompare(b)),
    });
    const cached = jitiLoaders.get(cacheKey);
    if (cached) {
      return cached;
    }
    const loader = createJiti(import.meta.url, {
      ...buildPluginLoaderJitiOptions(aliasMap),
      tryNative,
    });
    jitiLoaders.set(cacheKey, loader);
    return loader;
  };
}

const loadModule = createModuleLoader();

function loadBundledChannelContractSurfaceEntries(): Array<{
  pluginId: string;
  surface: unknown;
}> {
  const discovery = discoverOpenClawPlugins({ cache: false });
  const manifestRegistry = loadPluginManifestRegistry({
    cache: false,
    config: {},
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const surfaces: Array<{ pluginId: string; surface: unknown }> = [];
  for (const manifest of manifestRegistry.plugins) {
    if (manifest.origin !== "bundled" || manifest.channels.length === 0) {
      continue;
    }
    const modulePath = path.join(manifest.rootDir, CONTRACT_BASENAME);
    if (!fs.existsSync(modulePath)) {
      continue;
    }
    try {
      surfaces.push({
        pluginId: manifest.id,
        surface: loadModule(modulePath)(modulePath),
      });
    } catch {
      continue;
    }
  }
  return surfaces;
}

export function getBundledChannelContractSurfaceEntries(): Array<{
  pluginId: string;
  surface: unknown;
}> {
  if (cachedSurfaceEntries) {
    return cachedSurfaceEntries;
  }
  // Reentrancy guard: loading a contract-api.ts module (via jiti) may transitively
  // call back into `listChannelSecretTargetRegistryEntries` -> `getBundledChannelContractSurfaces`
  // -> `getBundledChannelContractSurfaceEntries` before the current load completes.
  // Without this guard the re-entry restarts `loadBundledChannelContractSurfaceEntries()`
  // from scratch and each subsequent channel load re-enters again, producing a
  // `RangeError: Maximum call stack size exceeded`. Returning empty entries
  // during the in-flight load is safe: the re-entrant probe sees no surfaces
  // and proceeds without triggering further recursion.
  if (contractSurfacesLoading) {
    return EMPTY_CONTRACT_SURFACE_ENTRIES;
  }

  contractSurfacesLoading = true;
  try {
    cachedSurfaceEntries = loadBundledChannelContractSurfaceEntries();
  } finally {
    contractSurfacesLoading = false;
  }
  return cachedSurfaceEntries;
}

export function getBundledChannelContractSurfaces(): unknown[] {
  if (cachedSurfaces) {
    return cachedSurfaces;
  }
  cachedSurfaces = getBundledChannelContractSurfaceEntries().map((entry) => entry.surface);
  return cachedSurfaces;
}
