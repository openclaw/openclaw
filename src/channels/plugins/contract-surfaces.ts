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

const CONTRACT_SURFACE_BASENAMES = [
  "contract-surfaces.ts",
  "contract-surfaces.js",
  "contract-api.ts",
  "contract-api.js",
] as const;

let cachedSurfaces: unknown[] | null = null;
let cachedSurfaceEntries: Array<{
  pluginId: string;
  surface: unknown;
}> | null = null;

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

function resolveContractSurfaceModulePath(rootDir: string): string | null {
  for (const basename of CONTRACT_SURFACE_BASENAMES) {
    const modulePath = path.join(rootDir, basename);
    if (fs.existsSync(modulePath)) {
      return modulePath;
    }
  }
  return null;
}

function loadBundledChannelContractSurfaces(): unknown[] {
  return loadBundledChannelContractSurfaceEntries().map((entry) => entry.surface);
}

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
    const modulePath = resolveContractSurfaceModulePath(manifest.rootDir);
    if (!modulePath) {
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

export function getBundledChannelContractSurfaces(): unknown[] {
  cachedSurfaces ??= loadBundledChannelContractSurfaces();
  return cachedSurfaces;
}

export function getBundledChannelContractSurfaceEntries(): Array<{
  pluginId: string;
  surface: unknown;
}> {
  cachedSurfaceEntries ??= loadBundledChannelContractSurfaceEntries();
  return cachedSurfaceEntries;
}
