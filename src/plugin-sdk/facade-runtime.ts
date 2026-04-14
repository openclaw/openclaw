import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { resolveBundledPluginPublicSurfacePath } from "../plugins/bundled-plugin-metadata.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../plugins/config-state.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../plugins/manifest-registry.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  resolveLoaderPackageRoot,
  shouldPreferNativeJiti,
} from "../plugins/sdk-alias.js";

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

// These maps are intentionally stored on globalThis so that every jiti module
// instance shares the same cache.  When root-alias.cjs creates a new jiti
// context to load compat.ts, which in turn imports facade-runtime.ts, that
// second module instance would otherwise have an empty local Map and re-enter
// loadBundledPluginPublicSurfaceModuleSync for the same path, causing an
// unbounded call stack.  Using a process-scoped symbol guarantees a single
// source of truth regardless of how many jiti contexts are alive.
const FACADE_MODULES_KEY = Symbol.for("openclaw.facade-runtime.loadedFacadeModules");
const FACADE_PLUGIN_IDS_KEY = Symbol.for("openclaw.facade-runtime.loadedFacadePluginIds");

type GlobalWithFacadeState = typeof globalThis & {
  [FACADE_MODULES_KEY]?: Map<string, unknown>;
  [FACADE_PLUGIN_IDS_KEY]?: Set<string>;
};

function getProcessScopedFacadeModules(): Map<string, unknown> {
  const g = globalThis as GlobalWithFacadeState;
  if (!g[FACADE_MODULES_KEY]) {
    g[FACADE_MODULES_KEY] = new Map<string, unknown>();
  }
  return g[FACADE_MODULES_KEY]!;
}

function getProcessScopedFacadePluginIds(): Set<string> {
  const g = globalThis as GlobalWithFacadeState;
  if (!g[FACADE_PLUGIN_IDS_KEY]) {
    g[FACADE_PLUGIN_IDS_KEY] = new Set<string>();
  }
  return g[FACADE_PLUGIN_IDS_KEY]!;
}

const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();
let cachedBoundaryRawConfig: OpenClawConfig | undefined;
let cachedBoundaryResolvedConfig:
  | {
      rawConfig: OpenClawConfig;
      config: OpenClawConfig;
      normalizedPluginsConfig: ReturnType<typeof normalizePluginsConfig>;
      activationSource: ReturnType<typeof createPluginActivationSource>;
      autoEnabledReasons: Record<string, string[]>;
    }
  | undefined;

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

function resolveFacadeModuleLocation(params: {
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
    if (!modulePath) {
      return null;
    }
    return {
      modulePath,
      boundaryRoot:
        bundledPluginsDir && modulePath.startsWith(path.resolve(bundledPluginsDir) + path.sep)
          ? path.resolve(bundledPluginsDir)
          : OPENCLAW_PACKAGE_ROOT,
    };
  }
  const modulePath = resolveBundledPluginPublicSurfacePath({
    rootDir: OPENCLAW_PACKAGE_ROOT,
    ...(bundledPluginsDir ? { bundledPluginsDir } : {}),
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
  });
  if (!modulePath) {
    return null;
  }
  return {
    modulePath,
    boundaryRoot:
      bundledPluginsDir && modulePath.startsWith(path.resolve(bundledPluginsDir) + path.sep)
        ? path.resolve(bundledPluginsDir)
        : OPENCLAW_PACKAGE_ROOT,
  };
}

function getJiti(modulePath: string) {
  const tryNative =
    shouldPreferNativeJiti(modulePath) || modulePath.includes(`${path.sep}dist${path.sep}`);
  const aliasMap = buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url);
  const cacheKey = JSON.stringify({
    tryNative,
    aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
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
}

function readFacadeBoundaryConfigSafely(): OpenClawConfig {
  try {
    const config = loadConfig();
    return config && typeof config === "object" ? config : EMPTY_FACADE_BOUNDARY_CONFIG;
  } catch {
    return EMPTY_FACADE_BOUNDARY_CONFIG;
  }
}

function getFacadeBoundaryResolvedConfig() {
  const rawConfig = readFacadeBoundaryConfigSafely();
  if (cachedBoundaryResolvedConfig && cachedBoundaryRawConfig === rawConfig) {
    return cachedBoundaryResolvedConfig;
  }

  const autoEnabled = applyPluginAutoEnable({
    config: rawConfig,
    env: process.env,
  });
  const config = autoEnabled.config;
  const resolved = {
    rawConfig,
    config,
    normalizedPluginsConfig: normalizePluginsConfig(config?.plugins),
    activationSource: createPluginActivationSource({ config: rawConfig }),
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
  };
  cachedBoundaryRawConfig = rawConfig;
  cachedBoundaryResolvedConfig = resolved;
  return resolved;
}

function resolveBundledPluginManifestRecordByDirName(dirName: string): PluginManifestRecord | null {
  const { config } = getFacadeBoundaryResolvedConfig();
  return (
    loadPluginManifestRegistry({
      config,
      cache: true,
    }).plugins.find(
      (plugin) => plugin.origin === "bundled" && path.basename(plugin.rootDir) === dirName,
    ) ?? null
  );
}

function resolveTrackedFacadePluginId(dirName: string): string {
  return resolveBundledPluginManifestRecordByDirName(dirName)?.id ?? dirName;
}

function resolveBundledPluginPublicSurfaceAccess(params: {
  dirName: string;
  artifactBasename: string;
}): { allowed: boolean; pluginId?: string; reason?: string } {
  if (
    params.artifactBasename === "runtime-api.js" &&
    ALWAYS_ALLOWED_RUNTIME_DIR_NAMES.has(params.dirName)
  ) {
    return {
      allowed: true,
      pluginId: params.dirName,
    };
  }

  const manifestRecord = resolveBundledPluginManifestRecordByDirName(params.dirName);
  if (!manifestRecord) {
    return {
      allowed: false,
      reason: `no bundled plugin manifest found for ${params.dirName}`,
    };
  }
  const { config, normalizedPluginsConfig, activationSource, autoEnabledReasons } =
    getFacadeBoundaryResolvedConfig();
  const activationState = resolveEffectivePluginActivationState({
    id: manifestRecord.id,
    origin: manifestRecord.origin,
    config: normalizedPluginsConfig,
    rootConfig: config,
    enabledByDefault: manifestRecord.enabledByDefault,
    activationSource,
    autoEnabledReason: autoEnabledReasons[manifestRecord.id]?.[0],
  });
  if (activationState.enabled) {
    return {
      allowed: true,
      pluginId: manifestRecord.id,
    };
  }

  return {
    allowed: false,
    pluginId: manifestRecord.id,
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
    return value;
  };
}

function createLazyFacadeProxyValue<T extends object>(params: {
  load: () => T;
  target: object;
}): T {
  const resolve = createLazyFacadeValueLoader(params.load);
  return new Proxy(params.target, {
    defineProperty(_target, property, descriptor) {
      return Reflect.defineProperty(resolve(), property, descriptor);
    },
    deleteProperty(_target, property) {
      return Reflect.deleteProperty(resolve(), property);
    },
    get(_target, property, receiver) {
      return Reflect.get(resolve(), property, receiver);
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(resolve(), property);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolve());
    },
    has(_target, property) {
      return Reflect.has(resolve(), property);
    },
    isExtensible() {
      return Reflect.isExtensible(resolve());
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    preventExtensions() {
      return Reflect.preventExtensions(resolve());
    },
    set(_target, property, value, receiver) {
      return Reflect.set(resolve(), property, value, receiver);
    },
    setPrototypeOf(_target, prototype) {
      return Reflect.setPrototypeOf(resolve(), prototype);
    },
  }) as T;
}

export function createLazyFacadeObjectValue<T extends object>(load: () => T): T {
  return createLazyFacadeProxyValue({ load, target: {} });
}

export function createLazyFacadeArrayValue<T extends readonly unknown[]>(load: () => T): T {
  return createLazyFacadeProxyValue({ load, target: [] });
}

export function loadBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
}): T {
  const location = resolveFacadeModuleLocation(params);
  if (!location) {
    throw new Error(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  const facadeModules = getProcessScopedFacadeModules();
  const cached = facadeModules.get(location.modulePath);
  if (cached) {
    return cached as T;
  }

  const opened = openBoundaryFileSync({
    absolutePath: location.modulePath,
    rootPath: location.boundaryRoot,
    boundaryLabel:
      location.boundaryRoot === OPENCLAW_PACKAGE_ROOT
        ? "OpenClaw package root"
        : "bundled plugin directory",
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(
      `Unable to open bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
      { cause: opened.error },
    );
  }
  fs.closeSync(opened.fd);

  // Place a sentinel object in the cache *before* the Jiti load begins.
  // If a transitive dependency of the loaded module re-enters this function
  // for the same modulePath (circular facade reference), it will receive the
  // sentinel instead of recursing infinitely.  Once the real module finishes
  // loading, Object.assign() back-fills the sentinel so any references
  // captured during the circular load phase see the final exports.
  const sentinel = {} as T;
  facadeModules.set(location.modulePath, sentinel);

  let loaded: T;
  try {
    // Track the owning plugin once module evaluation begins. Facade top-level
    // code may have already executed even if the module later throws.
    getProcessScopedFacadePluginIds().add(resolveTrackedFacadePluginId(params.dirName));
    loaded = getJiti(location.modulePath)(location.modulePath) as T;
    Object.assign(sentinel, loaded);
  } catch (err) {
    facadeModules.delete(location.modulePath);
    throw err;
  }

  return sentinel;
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
  const access = resolveBundledPluginPublicSurfaceAccess(params);
  if (!access.allowed) {
    const pluginLabel = access.pluginId ?? params.dirName;
    throw new Error(
      `Bundled plugin public surface access blocked for "${pluginLabel}" via ${params.dirName}/${params.artifactBasename}: ${access.reason ?? "plugin runtime is not activated"}`,
    );
  }
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

export function listImportedBundledPluginFacadeIds(): string[] {
  return [...getProcessScopedFacadePluginIds()].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export function resetFacadeRuntimeStateForTest(): void {
  getProcessScopedFacadeModules().clear();
  getProcessScopedFacadePluginIds().clear();
  jitiLoaders.clear();
  cachedBoundaryRawConfig = undefined;
  cachedBoundaryResolvedConfig = undefined;
}
