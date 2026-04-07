import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { resolveBundledPluginPublicSurfacePath } from "../plugins/public-surface-runtime.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../plugins/config-state.js";
import { discoverOpenClawPlugins } from "../plugins/discovery.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { checkMinHostVersion } from "../plugins/min-host-version.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  resolveLoaderPackageRoot,
  shouldPreferNativeJiti,
} from "../plugins/sdk-alias.js";
import { resolveCompatibilityHostVersion } from "../version.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"] as const;
const OPENCLAW_SOURCE_EXTENSIONS_ROOT = path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions");
const cachedFacadeModuleLocationsByKey = new Map<
  string,
  {
    modulePath: string;
    boundaryRoot: string;
  } | null
>();

function createFacadeResolutionKey(params: { dirName: string; artifactBasename: string }): string {
  const bundledPluginsDir = resolveBundledPluginsDir();
  return `${params.dirName}::${params.artifactBasename}::${bundledPluginsDir ? path.resolve(bundledPluginsDir) : "<default>"}`;
}

const bundledFacadeIdentityCache = new Map<
  string,
  { id: string; origin: "bundled"; enabledByDefault?: boolean } | null
>();

function resolveSourceFirstPublicSurfacePath(params: {
  bundledPluginsDir?: string;
  dirName: string;
  artifactBasename: string;
}): string | null {
  const sourceBaseName = params.artifactBasename.replace(/\.js$/u, "");
  const sourceRoot = params.bundledPluginsDir ?? path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions");
  for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
    const candidate = path.resolve(sourceRoot, params.dirName, `${sourceBaseName}${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveRegistryPluginModuleLocationFromRegistry(params: {
  registry: readonly Pick<PluginManifestRecord, "id" | "rootDir" | "channels">[];
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  type RegistryRecord = (typeof params.registry)[number];
  const tiers: Array<(plugin: RegistryRecord) => boolean> = [
    (plugin) => plugin.id === params.dirName,
    (plugin) => path.basename(plugin.rootDir) === params.dirName,
    (plugin) => plugin.channels.includes(params.dirName),
  ];
  const artifactBasename = params.artifactBasename.replace(/^\.\//u, "");
  const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
  for (const matchFn of tiers) {
    for (const record of params.registry.filter(matchFn)) {
      const rootDir = path.resolve(record.rootDir);
      const builtCandidate = path.join(rootDir, artifactBasename);
      if (fs.existsSync(builtCandidate)) {
        return { modulePath: builtCandidate, boundaryRoot: rootDir };
      }
      for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
        const sourceCandidate = path.join(rootDir, `${sourceBaseName}${ext}`);
        if (fs.existsSync(sourceCandidate)) {
          return { modulePath: sourceCandidate, boundaryRoot: rootDir };
        }
      }
    }
  }
  return null;
}

function resolveRegistryPluginModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  return loadFacadeActivationCheckRuntime().resolveRegistryPluginModuleLocation({
    ...params,
    resolutionKey: createFacadeResolutionKey(params),
  });
}

function resolveFacadeModuleLocationUncached(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  const bundledPluginsDir = resolveBundledPluginsDir();
  const preferSource = !CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`);
  if (preferSource) {
    const modulePath =
      resolveSourceFirstPublicSurfacePath({
        ...params,
        ...(bundledPluginsDir ? { bundledPluginsDir } : {}),
      }) ??
      resolveSourceFirstPublicSurfacePath(params) ??
      resolveBundledPluginPublicSurfacePath({
        rootDir: OPENCLAW_PACKAGE_ROOT,
        ...(bundledPluginsDir ? { bundledPluginsDir } : {}),
        dirName: params.dirName,
        artifactBasename: params.artifactBasename,
      });
    if (modulePath) {
      return {
        modulePath,
        boundaryRoot:
          bundledPluginsDir && modulePath.startsWith(path.resolve(bundledPluginsDir) + path.sep)
            ? path.resolve(bundledPluginsDir)
            : OPENCLAW_PACKAGE_ROOT,
      };
    }
    return resolveRegistryPluginModuleLocation(params);
  }
  const modulePath = resolveBundledPluginPublicSurfacePath({
    rootDir: OPENCLAW_PACKAGE_ROOT,
    ...(bundledPluginsDir ? { bundledPluginsDir } : {}),
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
  });
  if (modulePath) {
    return {
      modulePath,
      boundaryRoot:
        bundledPluginsDir && modulePath.startsWith(path.resolve(bundledPluginsDir) + path.sep)
          ? path.resolve(bundledPluginsDir)
          : OPENCLAW_PACKAGE_ROOT,
    };
  }
  return resolveRegistryPluginModuleLocation(params);
}

function resolveFacadeModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  const key = createFacadeResolutionKey(params);
  if (cachedFacadeModuleLocationsByKey.has(key)) {
    return cachedFacadeModuleLocationsByKey.get(key) ?? null;
  }
  const resolved = resolveFacadeModuleLocationUncached(params);
  cachedFacadeModuleLocationsByKey.set(key, resolved);
  return resolved;
}

type BundledPluginPublicSurfaceParams = {
  dirName: string;
  artifactBasename: string;
};

type FacadeActivationCheckRuntimeModule = typeof import("./facade-activation-check.runtime.js");
type JitiLoader = ReturnType<(typeof import("jiti"))["createJiti"]>;

  bundledFacadeIdentityCache.clear();

  const autoEnabled = applyPluginAutoEnable({
    config: rawConfig,
    env: process.env,
  });
  const config = autoEnabled.config;
  const resolved = {
    rawConfig,
    config,
    normalizedPluginsConfig: normalizePluginsConfig(config?.plugins),
    sourceNormalizedPluginsConfig: normalizePluginsConfig(rawConfig?.plugins),
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
  };
  cachedBoundaryRawConfig = rawConfig;
  cachedBoundaryResolvedConfig = resolved;
  return resolved;
}

function resolveBundledFacadeIdentityByDirName(dirName: string): {
  id: string;
  origin: "bundled";
  enabledByDefault?: boolean;
} | null {
  const cached = bundledFacadeIdentityCache.get(dirName);
  if (cached !== undefined || bundledFacadeIdentityCache.has(dirName)) {
    return cached ?? null;
  }
  const { config } = getFacadeBoundaryResolvedConfig();
  const normalized = normalizePluginsConfig(config.plugins);
  const discovery = discoverOpenClawPlugins({
    extraPaths: normalized.loadPaths,
    cache: true,
    env: process.env,
  });

  const candidate = discovery.candidates.find(
    (entry) => entry.origin === "bundled" && path.basename(entry.rootDir) === dirName,
  );

  if (!candidate) {
    return null;
  }

  const minHostVersionCheck = checkMinHostVersion({
    currentVersion: resolveCompatibilityHostVersion(process.env),
    minHostVersion: candidate.packageManifest?.install?.minHostVersion,
  });
  if (!minHostVersionCheck.ok) {
    bundledFacadeIdentityCache.set(dirName, null);
    return null;
  }

  const manifestRes = loadPluginManifest(candidate.rootDir, false);
  if (!manifestRes.ok) {
    bundledFacadeIdentityCache.set(dirName, null);
    return null;
  }

  return {
    id: manifestRes.manifest.id,
    origin: "bundled" as const,
    enabledByDefault: manifestRes.manifest.enabledByDefault === true ? true : undefined,
  };
}

function resolveTrackedFacadePluginId(dirName: string): string {
  return resolveBundledFacadeIdentityByDirName(dirName)?.id ?? dirName;
}

function loadFacadeActivationCheckRuntime(): FacadeActivationCheckRuntimeModule {
  if (facadeActivationCheckRuntimeModule) {
    return facadeActivationCheckRuntimeModule;
  }

  const {
    rawConfig,
    config,
    normalizedPluginsConfig,
    sourceNormalizedPluginsConfig,
    autoEnabledReasons,
  } = getFacadeBoundaryResolvedConfig();

  const manifestIdentity = resolveBundledFacadeIdentityByDirName(params.dirName);
  if (!manifestIdentity) {
    return {
      allowed: false,
      reason: `no bundled plugin manifest found for ${params.dirName}`,
    };
  }

  const activationState = resolveEffectivePluginActivationState({
    id: manifestIdentity.id,
    origin: manifestIdentity.origin,
    config: normalizedPluginsConfig,
    rootConfig: config,
    enabledByDefault: manifestIdentity.enabledByDefault,
    sourceConfig: sourceNormalizedPluginsConfig,
    sourceRootConfig: rawConfig,
    autoEnabledReason: autoEnabledReasons[manifestIdentity.id]?.[0],
  });
  if (activationState.enabled) {
    return {
      allowed: true,
      pluginId: manifestIdentity.id,
    };
  }

  return {
    allowed: false,
    pluginId: manifestIdentity.id,
    reason: activationState.reason ?? "plugin runtime is not activated",
  };
}

function createLazyFacadeValueLoader<T>(load: () => T): () => T {
  let loaded = false;
  let value: T;
  return () => {
    if (!loaded) {
      value = load();
      loaded = true;
    }
  }
  throw new Error("Unable to load facade activation check runtime");
}

function loadFacadeModuleAtLocationSync<T extends object>(params: {
  location: FacadeModuleLocation;
  trackedPluginId: string | (() => string);
  loadModule?: (modulePath: string) => T;
}): T {
  return loadFacadeModuleAtLocationSyncShared(params);
}

function buildFacadeActivationCheckParams(
  params: BundledPluginPublicSurfaceParams,
  location: FacadeModuleLocation | null = resolveFacadeModuleLocation(params),
) {
  return {
    ...params,
    location,
    sourceExtensionsRoot: OPENCLAW_SOURCE_EXTENSIONS_ROOT,
    resolutionKey: createFacadeResolutionKey(params),
  };
}

export function loadBundledPluginPublicSurfaceModuleSync<T extends object>(
  params: BundledPluginPublicSurfaceParams,
): T {
  const location = resolveFacadeModuleLocation(params);
  const trackedPluginId = () =>
    loadFacadeActivationCheckRuntime().resolveTrackedFacadePluginId(
      buildFacadeActivationCheckParams(params, location),
    );
  if (!location) {
    return loadBundledPluginPublicSurfaceModuleSyncLight<T>({
      ...params,
      trackedPluginId,
    });
  }
  return loadFacadeModuleAtLocationSync<T>({
    location,
    trackedPluginId,
  });
}

export function canLoadActivatedBundledPluginPublicSurface(params: {
  dirName: string;
  artifactBasename: string;
}): boolean {
  return loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(
    buildFacadeActivationCheckParams(params),
  ).allowed;
}

export function loadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
}): T {
  loadFacadeActivationCheckRuntime().resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(
    buildFacadeActivationCheckParams(params),
  );
  return loadBundledPluginPublicSurfaceModuleSync<T>(params);
}

export function tryLoadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
}): T | null {
  const access = loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(
    buildFacadeActivationCheckParams(params),
  );
  if (!access.allowed) {
    return null;
  }
  return loadBundledPluginPublicSurfaceModuleSync<T>(params);
}

export function resetFacadeRuntimeStateForTest(): void {
  resetFacadeLoaderStateForTest();
  facadeActivationCheckRuntimeModule?.resetFacadeActivationCheckRuntimeStateForTest();
  facadeActivationCheckRuntimeModule = undefined;
  facadeActivationCheckRuntimeJiti = undefined;
  cachedFacadeModuleLocationsByKey.clear();
}

export const __testing = {
  loadFacadeModuleAtLocationSync,
  resolveRegistryPluginModuleLocationFromRegistry,
  resolveFacadeModuleLocation,
  evaluateBundledPluginPublicSurfaceAccess: ((
    ...args: Parameters<
      FacadeActivationCheckRuntimeModule["evaluateBundledPluginPublicSurfaceAccess"]
    >
  ) =>
    loadFacadeActivationCheckRuntime().evaluateBundledPluginPublicSurfaceAccess(
      ...args,
    )) as FacadeActivationCheckRuntimeModule["evaluateBundledPluginPublicSurfaceAccess"],
  throwForBundledPluginPublicSurfaceAccess: ((
    ...args: Parameters<
      FacadeActivationCheckRuntimeModule["throwForBundledPluginPublicSurfaceAccess"]
    >
  ) =>
    loadFacadeActivationCheckRuntime().throwForBundledPluginPublicSurfaceAccess(
      ...args,
    )) as FacadeActivationCheckRuntimeModule["throwForBundledPluginPublicSurfaceAccess"],
  resolveActivatedBundledPluginPublicSurfaceAccessOrThrow: ((
    params: BundledPluginPublicSurfaceParams,
  ) =>
    loadFacadeActivationCheckRuntime().resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(
      buildFacadeActivationCheckParams(params),
    )) as (params: BundledPluginPublicSurfaceParams) => {
    allowed: boolean;
    pluginId?: string;
    reason?: string;
  },
  resolveBundledPluginPublicSurfaceAccess: ((params: BundledPluginPublicSurfaceParams) =>
    loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(
      buildFacadeActivationCheckParams(params),
    )) as (params: BundledPluginPublicSurfaceParams) => {
    allowed: boolean;
    pluginId?: string;
    reason?: string;
  },
  resolveTrackedFacadePluginId: ((params: BundledPluginPublicSurfaceParams) =>
    loadFacadeActivationCheckRuntime().resolveTrackedFacadePluginId(
      buildFacadeActivationCheckParams(params),
    )) as (params: BundledPluginPublicSurfaceParams) => string,
};
