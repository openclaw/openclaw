import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { resolveConfigPath } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { configMayNeedPluginAutoEnable } from "../config/plugin-auto-enable.shared.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../plugins/config-state.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../plugins/manifest-registry.js";
import { resolveBundledPluginPublicSurfacePath } from "../plugins/public-surface-runtime.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import {
  loadBundledPluginPublicSurfaceModuleSync as loadBundledPluginPublicSurfaceModuleSyncLight,
  loadFacadeModuleAtLocationSync as loadFacadeModuleAtLocationSyncShared,
  resetFacadeLoaderStateForTest,
  type FacadeModuleLocation,
} from "./facade-loader.js";
export {
  createLazyFacadeArrayValue,
  createLazyFacadeObjectValue,
  listImportedBundledPluginFacadeIds,
} from "./facade-loader.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"] as const;
const ALWAYS_ALLOWED_RUNTIME_DIR_NAMES = new Set([
  "image-generation-core",
  "media-understanding-core",
  "speech-core",
]);
const EMPTY_FACADE_BOUNDARY_CONFIG: OpenClawConfig = {};
const OPENCLAW_SOURCE_EXTENSIONS_ROOT = path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions");
let cachedBoundaryRawConfig: OpenClawConfig | undefined;
let cachedBoundaryResolvedConfigKey: string | undefined;
let cachedBoundaryConfigFileState:
  | {
      configPath: string;
      mtimeMs: number;
      size: number;
      rawConfig: OpenClawConfig;
    }
  | undefined;
let cachedBoundaryResolvedConfig:
  | {
      rawConfig: OpenClawConfig;
      config: OpenClawConfig;
      normalizedPluginsConfig: ReturnType<typeof normalizePluginsConfig>;
      activationSource: ReturnType<typeof createPluginActivationSource>;
      autoEnabledReasons: Record<string, string[]>;
    }
  | undefined;
let cachedManifestRegistry: readonly PluginManifestRecord[] | undefined;
const cachedFacadeModuleLocationsByKey = new Map<
  string,
  {
    modulePath: string;
    boundaryRoot: string;
  } | null
>();
const cachedFacadeManifestRecordsByKey = new Map<string, FacadePluginManifestLike | null>();
const cachedFacadePublicSurfaceAccessByKey = new Map<
  string,
  { allowed: boolean; pluginId?: string; reason?: string }
>();

type FacadePluginManifestLike = Pick<
  PluginManifestRecord,
  "id" | "origin" | "enabledByDefault" | "rootDir" | "channels"
>;

function createFacadeResolutionKey(params: { dirName: string; artifactBasename: string }): string {
  const bundledPluginsDir = resolveBundledPluginsDir();
  return `${params.dirName}::${params.artifactBasename}::${bundledPluginsDir ? path.resolve(bundledPluginsDir) : "<default>"}`;
}

function getFacadeManifestRegistry(): readonly PluginManifestRecord[] {
  if (cachedManifestRegistry) {
    return cachedManifestRegistry;
  }
  cachedManifestRegistry = loadPluginManifestRegistry({
    config: getFacadeBoundaryResolvedConfig().config,
    cache: true,
  }).plugins;
  return cachedManifestRegistry;
}

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
  return resolveRegistryPluginModuleLocationFromRegistry({
    registry: getFacadeManifestRegistry(),
    ...params,
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

function readFacadeBoundaryConfigSafely(): {
  rawConfig: OpenClawConfig;
  cacheKey?: string;
} {
  try {
    const runtimeSnapshot = getRuntimeConfigSnapshot();
    if (runtimeSnapshot) {
      return { rawConfig: runtimeSnapshot };
    }
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) {
      return { rawConfig: EMPTY_FACADE_BOUNDARY_CONFIG, cacheKey: `missing:${configPath}` };
    }
    const stat = fs.statSync(configPath);
    if (
      cachedBoundaryConfigFileState &&
      cachedBoundaryConfigFileState.configPath === configPath &&
      cachedBoundaryConfigFileState.mtimeMs === stat.mtimeMs &&
      cachedBoundaryConfigFileState.size === stat.size
    ) {
      return {
        rawConfig: cachedBoundaryConfigFileState.rawConfig,
        cacheKey: `file:${configPath}:${stat.mtimeMs}:${stat.size}`,
      };
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    const rawConfig =
      parsed && typeof parsed === "object"
        ? (parsed as OpenClawConfig)
        : EMPTY_FACADE_BOUNDARY_CONFIG;
    cachedBoundaryConfigFileState = {
      configPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      rawConfig,
    };
    return {
      rawConfig,
      cacheKey: `file:${configPath}:${stat.mtimeMs}:${stat.size}`,
    };
  } catch {
    return { rawConfig: EMPTY_FACADE_BOUNDARY_CONFIG };
  }
}

function getFacadeBoundaryResolvedConfig() {
  const readResult = readFacadeBoundaryConfigSafely();
  const { rawConfig } = readResult;
  if (
    cachedBoundaryResolvedConfig &&
    ((readResult.cacheKey && cachedBoundaryResolvedConfigKey === readResult.cacheKey) ||
      (!readResult.cacheKey && cachedBoundaryRawConfig === rawConfig))
  ) {
    return cachedBoundaryResolvedConfig;
  }

  const autoEnabled = configMayNeedPluginAutoEnable(rawConfig, process.env)
    ? applyPluginAutoEnable({
        config: rawConfig,
        env: process.env,
      })
    : {
        config: rawConfig,
        autoEnabledReasons: {} as Record<string, string[]>,
      };
  const config = autoEnabled.config;
  const resolved = {
    rawConfig,
    config,
    normalizedPluginsConfig: normalizePluginsConfig(config?.plugins),
    activationSource: createPluginActivationSource({ config: rawConfig }),
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
  };
  cachedBoundaryRawConfig = rawConfig;
  cachedBoundaryResolvedConfigKey = readResult.cacheKey;
  cachedBoundaryResolvedConfig = resolved;
  return resolved;
}

function resolveBundledMetadataManifestRecord(params: {
  dirName: string;
  artifactBasename: string;
}): FacadePluginManifestLike | null {
  const location = resolveFacadeModuleLocation(params);
  if (!location) {
    return null;
  }
  if (location.modulePath.startsWith(`${OPENCLAW_SOURCE_EXTENSIONS_ROOT}${path.sep}`)) {
    const relativeToExtensions = path.relative(
      OPENCLAW_SOURCE_EXTENSIONS_ROOT,
      location.modulePath,
    );
    const resolvedDirName = relativeToExtensions.split(path.sep)[0];
    if (!resolvedDirName) {
      return null;
    }
    const metadata = listBundledPluginMetadata({
      includeChannelConfigs: false,
      includeSyntheticChannelConfigs: false,
    }).find(
      (entry) =>
        entry.dirName === resolvedDirName ||
        entry.manifest.id === params.dirName ||
        entry.manifest.channels?.includes(params.dirName),
    );
    if (!metadata) {
      return null;
    }
    return {
      id: metadata.manifest.id,
      origin: "bundled",
      enabledByDefault: metadata.manifest.enabledByDefault,
      rootDir: path.resolve(OPENCLAW_SOURCE_EXTENSIONS_ROOT, metadata.dirName),
      channels: [...(metadata.manifest.channels ?? [])],
    };
  }
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    return null;
  }
  const normalizedBundledPluginsDir = path.resolve(bundledPluginsDir);
  if (!location.modulePath.startsWith(`${normalizedBundledPluginsDir}${path.sep}`)) {
    return null;
  }
  const relativeToBundledDir = path.relative(normalizedBundledPluginsDir, location.modulePath);
  const resolvedDirName = relativeToBundledDir.split(path.sep)[0];
  if (!resolvedDirName) {
    return null;
  }
  const manifestPath = path.join(
    normalizedBundledPluginsDir,
    resolvedDirName,
    "openclaw.plugin.json",
  );
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const raw = JSON5.parse(fs.readFileSync(manifestPath, "utf8")) as {
      id?: unknown;
      enabledByDefault?: unknown;
      channels?: unknown;
    };
    if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
      return null;
    }
    return {
      id: raw.id,
      origin: "bundled",
      enabledByDefault: raw.enabledByDefault === true,
      rootDir: path.join(normalizedBundledPluginsDir, resolvedDirName),
      channels: Array.isArray(raw.channels)
        ? raw.channels.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function resolveBundledPluginManifestRecord(params: {
  dirName: string;
  artifactBasename: string;
}): FacadePluginManifestLike | null {
  const key = createFacadeResolutionKey(params);
  if (cachedFacadeManifestRecordsByKey.has(key)) {
    return cachedFacadeManifestRecordsByKey.get(key) ?? null;
  }

  const metadataRecord = resolveBundledMetadataManifestRecord(params);
  if (metadataRecord) {
    cachedFacadeManifestRecordsByKey.set(key, metadataRecord);
    return metadataRecord;
  }

  const registry = getFacadeManifestRegistry();
  const location = resolveFacadeModuleLocation(params);
  const resolved =
    (location
      ? registry.find((plugin) => {
          const normalizedRootDir = path.resolve(plugin.rootDir);
          const normalizedModulePath = path.resolve(location.modulePath);
          return (
            normalizedModulePath === normalizedRootDir ||
            normalizedModulePath.startsWith(`${normalizedRootDir}${path.sep}`)
          );
        })
      : null) ??
    registry.find((plugin) => plugin.id === params.dirName) ??
    registry.find((plugin) => path.basename(plugin.rootDir) === params.dirName) ??
    registry.find((plugin) => plugin.channels.includes(params.dirName)) ??
    null;
  cachedFacadeManifestRecordsByKey.set(key, resolved);
  return resolved;
}

function resolveTrackedFacadePluginId(params: {
  dirName: string;
  artifactBasename: string;
}): string {
  return resolveBundledPluginManifestRecord(params)?.id ?? params.dirName;
}

function resolveBundledPluginPublicSurfaceAccess(params: {
  dirName: string;
  artifactBasename: string;
}): { allowed: boolean; pluginId?: string; reason?: string } {
  const key = createFacadeResolutionKey(params);
  const cached = cachedFacadePublicSurfaceAccessByKey.get(key);
  if (cached) {
    return cached;
  }

  if (
    params.artifactBasename === "runtime-api.js" &&
    ALWAYS_ALLOWED_RUNTIME_DIR_NAMES.has(params.dirName)
  ) {
    const resolved = {
      allowed: true,
      pluginId: params.dirName,
    };
    cachedFacadePublicSurfaceAccessByKey.set(key, resolved);
    return resolved;
  }

  const manifestRecord = resolveBundledPluginManifestRecord(params);
  if (!manifestRecord) {
    const resolved = {
      allowed: false,
      reason: `no bundled plugin manifest found for ${params.dirName}`,
    };
    cachedFacadePublicSurfaceAccessByKey.set(key, resolved);
    return resolved;
  }
  const { config, normalizedPluginsConfig, activationSource, autoEnabledReasons } =
    getFacadeBoundaryResolvedConfig();
  const resolved = evaluateBundledPluginPublicSurfaceAccess({
    params,
    manifestRecord,
    config,
    normalizedPluginsConfig,
    activationSource,
    autoEnabledReasons,
  });
  cachedFacadePublicSurfaceAccessByKey.set(key, resolved);
  return resolved;
}

function evaluateBundledPluginPublicSurfaceAccess(params: {
  params: BundledPluginPublicSurfaceParams;
  manifestRecord: FacadePluginManifestLike;
  config: OpenClawConfig;
  normalizedPluginsConfig: ReturnType<typeof normalizePluginsConfig>;
  activationSource: ReturnType<typeof createPluginActivationSource>;
  autoEnabledReasons: Record<string, string[]>;
}): { allowed: boolean; pluginId?: string; reason?: string } {
  const activationState = resolveEffectivePluginActivationState({
    id: params.manifestRecord.id,
    origin: params.manifestRecord.origin,
    config: params.normalizedPluginsConfig,
    rootConfig: params.config,
    enabledByDefault: params.manifestRecord.enabledByDefault,
    activationSource: params.activationSource,
    autoEnabledReason: params.autoEnabledReasons[params.manifestRecord.id]?.[0],
  });
  if (activationState.enabled) {
    return {
      allowed: true,
      pluginId: params.manifestRecord.id,
    };
  }

  return {
    allowed: false,
    pluginId: params.manifestRecord.id,
    reason: activationState.reason ?? "plugin runtime is not activated",
  };
}

function throwForBundledPluginPublicSurfaceAccess(params: {
  access: { allowed: boolean; pluginId?: string; reason?: string };
  request: BundledPluginPublicSurfaceParams;
}): never {
  const pluginLabel = params.access.pluginId ?? params.request.dirName;
  throw new Error(
    `Bundled plugin public surface access blocked for "${pluginLabel}" via ${params.request.dirName}/${params.request.artifactBasename}: ${params.access.reason ?? "plugin runtime is not activated"}`,
  );
}

type BundledPluginPublicSurfaceParams = {
  dirName: string;
  artifactBasename: string;
};

function loadFacadeModuleAtLocationSync<T extends object>(params: {
  location: FacadeModuleLocation;
  trackedPluginId: string | (() => string);
  loadModule?: (modulePath: string) => T;
}): T {
  return loadFacadeModuleAtLocationSyncShared(params);
}

function resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(
  params: BundledPluginPublicSurfaceParams,
) {
  const access = resolveBundledPluginPublicSurfaceAccess(params);
  if (!access.allowed) {
    throwForBundledPluginPublicSurfaceAccess({
      access,
      request: params,
    });
  }
  return access;
}

export function loadBundledPluginPublicSurfaceModuleSync<T extends object>(
  params: BundledPluginPublicSurfaceParams,
): T {
  return loadBundledPluginPublicSurfaceModuleSyncLight<T>({
    ...params,
    trackedPluginId: () => resolveTrackedFacadePluginId(params),
  });
}

export function canLoadActivatedBundledPluginPublicSurface(params: {
  dirName: string;
  artifactBasename: string;
}): boolean {
  return resolveBundledPluginPublicSurfaceAccess(params).allowed;
}

export function loadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
}): T {
  resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(params);
  return loadBundledPluginPublicSurfaceModuleSync<T>(params);
}

export function tryLoadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
}): T | null {
  const access = resolveBundledPluginPublicSurfaceAccess(params);
  if (!access.allowed) {
    return null;
  }
  return loadBundledPluginPublicSurfaceModuleSync<T>(params);
}

export function resetFacadeRuntimeStateForTest(): void {
  resetFacadeLoaderStateForTest();
  cachedManifestRegistry = undefined;
  cachedBoundaryRawConfig = undefined;
  cachedBoundaryResolvedConfigKey = undefined;
  cachedBoundaryConfigFileState = undefined;
  cachedBoundaryResolvedConfig = undefined;
  cachedManifestRegistry = undefined;
  cachedFacadeModuleLocationsByKey.clear();
  cachedFacadeManifestRecordsByKey.clear();
  cachedFacadePublicSurfaceAccessByKey.clear();
}

export const __testing = {
  evaluateBundledPluginPublicSurfaceAccess,
  loadFacadeModuleAtLocationSync,
  resolveRegistryPluginModuleLocationFromRegistry,
  throwForBundledPluginPublicSurfaceAccess,
  resolveActivatedBundledPluginPublicSurfaceAccessOrThrow,
  resolveFacadeModuleLocation,
  resolveBundledPluginPublicSurfaceAccess,
  resolveTrackedFacadePluginId,
};
