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

function resolveContractSurfaceModulePaths(rootDir: string | undefined): string[] {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    return [];
  }
  const modulePaths: string[] = [];
  for (const basename of CONTRACT_SURFACE_BASENAMES) {
    const modulePath = path.join(rootDir, basename);
    if (!fs.existsSync(modulePath)) {
      continue;
    }
    const compiledDistModulePath = modulePath.replace(
      `${path.sep}dist-runtime${path.sep}`,
      `${path.sep}dist${path.sep}`,
    );
    // Prefer the compiled dist module over the dist-runtime shim so Jiti sees
    // the full named export surface instead of only local wrapper exports.
    if (compiledDistModulePath !== modulePath && fs.existsSync(compiledDistModulePath)) {
      modulePaths.push(compiledDistModulePath);
      continue;
    }
    modulePaths.push(modulePath);
  }
  return modulePaths;
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
    const modulePaths = resolveContractSurfaceModulePaths(manifest.rootDir);
    if (modulePaths.length === 0) {
      continue;
    }
    try {
      const surface = Object.assign(
        {},
        ...modulePaths.map((modulePath) => loadModule(modulePath)(modulePath) as object),
      );
      surfaces.push({
        pluginId: manifest.id,
        surface,
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
