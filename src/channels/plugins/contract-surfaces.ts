import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { discoverOpenClawPlugins } from "../../plugins/discovery.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  resolveLoaderPackageRoot,
  shouldPreferNativeJiti,
} from "../../plugins/sdk-alias.js";

const CONTRACT_SURFACE_BASENAMES = [
  "contract-surfaces.ts",
  "contract-surfaces.js",
  "contract-api.ts",
  "contract-api.js",
] as const;
const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"] as const;
const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type ContractSurfaceBasename = (typeof CONTRACT_SURFACE_BASENAMES)[number];

let cachedSurfaces: unknown[] | null = null;
let cachedSurfaceEntries: Array<{
  pluginId: string;
  surface: unknown;
}> | null = null;
const cachedPreferredSurfaceModules = new Map<string, unknown>();

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

function getContractSurfaceDiscoveryEnv(): NodeJS.ProcessEnv {
  if (RUNNING_FROM_BUILT_ARTIFACT) {
    return process.env;
  }
  return {
    ...process.env,
    VITEST: process.env.VITEST || "1",
  };
}

function matchesPreferredBasename(
  basename: ContractSurfaceBasename,
  preferredBasename: ContractSurfaceBasename | undefined,
): boolean {
  if (!preferredBasename) {
    return true;
  }
  return basename.replace(/\.[^.]+$/u, "") === preferredBasename.replace(/\.[^.]+$/u, "");
}

function resolveDistPreferredModulePath(modulePath: string): string {
  const compiledDistModulePath = modulePath.replace(
    `${path.sep}dist-runtime${path.sep}`,
    `${path.sep}dist${path.sep}`,
  );
  return compiledDistModulePath !== modulePath && fs.existsSync(compiledDistModulePath)
    ? compiledDistModulePath
    : modulePath;
}

function resolveContractSurfaceModulePaths(
  rootDir: string | undefined,
  preferredBasename?: ContractSurfaceBasename,
): string[] {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    return [];
  }
  const modulePaths: string[] = [];
  for (const basename of CONTRACT_SURFACE_BASENAMES) {
    if (!matchesPreferredBasename(basename, preferredBasename)) {
      continue;
    }
    const modulePath = path.join(rootDir, basename);
    if (!fs.existsSync(modulePath)) {
      continue;
    }
    modulePaths.push(resolveDistPreferredModulePath(modulePath));
  }
  return modulePaths;
}

function resolveSourceFirstContractSurfaceModulePaths(params: {
  rootDir: string | undefined;
  preferredBasename?: ContractSurfaceBasename;
}): string[] {
  if (typeof params.rootDir !== "string" || params.rootDir.length === 0) {
    return [];
  }
  if (RUNNING_FROM_BUILT_ARTIFACT) {
    return resolveContractSurfaceModulePaths(params.rootDir, params.preferredBasename);
  }

  const dirName = path.basename(path.resolve(params.rootDir));
  const sourceRoot = path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions", dirName);
  const modulePaths: string[] = [];

  for (const basename of CONTRACT_SURFACE_BASENAMES) {
    if (!matchesPreferredBasename(basename, params.preferredBasename)) {
      continue;
    }

    const sourceBaseName = basename.replace(/\.[^.]+$/u, "");
    let sourceCandidatePath: string | null = null;
    for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
      const candidate = path.join(sourceRoot, `${sourceBaseName}${ext}`);
      if (fs.existsSync(candidate)) {
        sourceCandidatePath = candidate;
        break;
      }
    }
    if (sourceCandidatePath) {
      modulePaths.push(sourceCandidatePath);
      continue;
    }

    const builtCandidates = resolveContractSurfaceModulePaths(params.rootDir, basename);
    if (builtCandidates[0]) {
      modulePaths.push(builtCandidates[0]);
    }
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
  const env = getContractSurfaceDiscoveryEnv();
  const discovery = discoverOpenClawPlugins({ cache: false, env });
  const manifestRegistry = loadPluginManifestRegistry({
    cache: false,
    env,
    config: {},
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const surfaces: Array<{ pluginId: string; surface: unknown }> = [];
  for (const manifest of manifestRegistry.plugins) {
    if (manifest.origin !== "bundled" || manifest.channels.length === 0) {
      continue;
    }
    const modulePath = resolveSourceFirstContractSurfaceModulePaths({
      rootDir: manifest.rootDir,
    })[0];
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

export function getBundledChannelContractSurfaceModule<T = unknown>(params: {
  pluginId: string;
  preferredBasename?: ContractSurfaceBasename;
}): T | null {
  const cacheKey = `${params.pluginId}:${params.preferredBasename ?? "*"}`;
  if (cachedPreferredSurfaceModules.has(cacheKey)) {
    return (cachedPreferredSurfaceModules.get(cacheKey) ?? null) as T | null;
  }
  const env = getContractSurfaceDiscoveryEnv();
  const discovery = discoverOpenClawPlugins({ cache: false, env });
  const manifestRegistry = loadPluginManifestRegistry({
    cache: false,
    env,
    config: {},
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const manifest = manifestRegistry.plugins.find(
    (entry) =>
      entry.origin === "bundled" && entry.channels.length > 0 && entry.id === params.pluginId,
  );
  if (!manifest) {
    cachedPreferredSurfaceModules.set(cacheKey, null);
    return null;
  }
  const modulePath = resolveSourceFirstContractSurfaceModulePaths({
    rootDir: manifest.rootDir,
    preferredBasename: params.preferredBasename,
  })[0];
  if (!modulePath) {
    cachedPreferredSurfaceModules.set(cacheKey, null);
    return null;
  }
  try {
    const module = loadModule(modulePath)(modulePath) as T;
    cachedPreferredSurfaceModules.set(cacheKey, module);
    return module;
  } catch {
    cachedPreferredSurfaceModules.set(cacheKey, null);
    return null;
  }
}
