import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";

const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"] as const;
type JitiLoader = ReturnType<(typeof import("jiti"))["createJiti"]>;
type SdkAliasRuntimeModule = Pick<
  typeof import("../plugins/sdk-alias.js"),
  | "buildPluginLoaderAliasMap"
  | "buildPluginLoaderJitiOptions"
  | "resolveLoaderPackageRoot"
  | "shouldPreferNativeJiti"
>;
type PublicSurfaceRuntimeModule = Pick<
  typeof import("../plugins/public-surface-runtime.js"),
  "resolveBundledPluginPublicSurfacePath"
>;
type BoundaryFileRuntimeModule = Pick<
  typeof import("../infra/boundary-file-read.js"),
  "openBoundaryFileSync"
>;

const nodeRequire = createRequire(import.meta.url);
const jitiLoaders = new Map<string, JitiLoader>();
const loadedFacadeModules = new Map<string, unknown>();
const loadedFacadePluginIds = new Set<string>();
const cachedFacadeModuleLocationsByKey = new Map<
  string,
  {
    modulePath: string;
    boundaryRoot: string;
  } | null
>();
let facadeLoaderJitiFactory:
  | ((...args: Parameters<(typeof import("jiti"))["createJiti"]>) => JitiLoader)
  | undefined;
let sdkAliasRuntimeModule: SdkAliasRuntimeModule | undefined;
let publicSurfaceRuntimeModule: PublicSurfaceRuntimeModule | undefined;
let boundaryFileRuntimeModule: BoundaryFileRuntimeModule | undefined;
let cachedOpenClawPackageRoot: string | undefined;

function getJitiFactory() {
  if (facadeLoaderJitiFactory) {
    return facadeLoaderJitiFactory;
  }
  const { createJiti } = nodeRequire("jiti") as typeof import("jiti");
  facadeLoaderJitiFactory = createJiti;
  return facadeLoaderJitiFactory;
}

function loadRuntimeModule<T>(params: { candidates: readonly string[]; errorMessage: string }): T {
  for (const candidate of params.candidates) {
    try {
      return nodeRequire(candidate) as T;
    } catch {
      // Try source/runtime candidates in order.
    }
  }
  const createJiti = getJitiFactory();
  const jiti = createJiti(import.meta.url, { tryNative: false });
  for (const candidate of params.candidates) {
    try {
      return jiti(candidate) as T;
    } catch {
      // Try source/runtime candidates in order.
    }
  }
  throw new Error(params.errorMessage);
}

function loadSdkAliasRuntime(): SdkAliasRuntimeModule {
  if (sdkAliasRuntimeModule) {
    return sdkAliasRuntimeModule;
  }
  sdkAliasRuntimeModule = loadRuntimeModule<SdkAliasRuntimeModule>({
    candidates: ["../plugins/sdk-alias.js", "../plugins/sdk-alias.ts"],
    errorMessage: "Unable to load plugin sdk-alias runtime",
  });
  return sdkAliasRuntimeModule;
}

function loadPublicSurfaceRuntime(): PublicSurfaceRuntimeModule {
  if (publicSurfaceRuntimeModule) {
    return publicSurfaceRuntimeModule;
  }
  publicSurfaceRuntimeModule = loadRuntimeModule<PublicSurfaceRuntimeModule>({
    candidates: ["../plugins/public-surface-runtime.js", "../plugins/public-surface-runtime.ts"],
    errorMessage: "Unable to load plugin public-surface runtime",
  });
  return publicSurfaceRuntimeModule;
}

function loadBoundaryFileRuntime(): BoundaryFileRuntimeModule {
  if (boundaryFileRuntimeModule) {
    return boundaryFileRuntimeModule;
  }
  boundaryFileRuntimeModule = loadRuntimeModule<BoundaryFileRuntimeModule>({
    candidates: ["../infra/boundary-file-read.js", "../infra/boundary-file-read.ts"],
    errorMessage: "Unable to load boundary-file runtime",
  });
  return boundaryFileRuntimeModule;
}

function getOpenClawPackageRoot() {
  if (cachedOpenClawPackageRoot) {
    return cachedOpenClawPackageRoot;
  }
  cachedOpenClawPackageRoot =
    loadSdkAliasRuntime().resolveLoaderPackageRoot({
      modulePath: fileURLToPath(import.meta.url),
      moduleUrl: import.meta.url,
    }) ?? fileURLToPath(new URL("../..", import.meta.url));
  return cachedOpenClawPackageRoot;
}

function createFacadeResolutionKey(params: { dirName: string; artifactBasename: string }): string {
  const bundledPluginsDir = resolveBundledPluginsDir();
  return `${params.dirName}::${params.artifactBasename}::${bundledPluginsDir ? path.resolve(bundledPluginsDir) : "<default>"}`;
}

function resolveSourceFirstPublicSurfacePath(params: {
  bundledPluginsDir?: string;
  dirName: string;
  artifactBasename: string;
}): string | null {
  const sourceBaseName = params.artifactBasename.replace(/\.js$/u, "");
  const sourceRoot =
    params.bundledPluginsDir ?? path.resolve(getOpenClawPackageRoot(), "extensions");
  for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
    const candidate = path.resolve(sourceRoot, params.dirName, `${sourceBaseName}${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
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
      loadPublicSurfaceRuntime().resolveBundledPluginPublicSurfacePath({
        rootDir: getOpenClawPackageRoot(),
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
            : getOpenClawPackageRoot(),
      };
    }
    return null;
  }
  const modulePath = loadPublicSurfaceRuntime().resolveBundledPluginPublicSurfacePath({
    rootDir: getOpenClawPackageRoot(),
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
        : getOpenClawPackageRoot(),
  };
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

function getJiti(modulePath: string) {
  const sdkAlias = loadSdkAliasRuntime();
  const tryNative =
    sdkAlias.shouldPreferNativeJiti(modulePath) ||
    modulePath.includes(`${path.sep}dist${path.sep}`);
  const aliasMap = sdkAlias.buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url);
  const cacheKey = JSON.stringify({
    tryNative,
    aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
  });
  const cached = jitiLoaders.get(cacheKey);
  if (cached) {
    return cached;
  }
  const loader = getJitiFactory()(import.meta.url, {
    ...sdkAlias.buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  jitiLoaders.set(cacheKey, loader);
  return loader;
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

export type FacadeModuleLocation = {
  modulePath: string;
  boundaryRoot: string;
};

export function loadFacadeModuleAtLocationSync<T extends object>(params: {
  location: FacadeModuleLocation;
  trackedPluginId: string | (() => string);
  loadModule?: (modulePath: string) => T;
}): T {
  const cached = loadedFacadeModules.get(params.location.modulePath);
  if (cached) {
    return cached as T;
  }

  const opened = loadBoundaryFileRuntime().openBoundaryFileSync({
    absolutePath: params.location.modulePath,
    rootPath: params.location.boundaryRoot,
    boundaryLabel:
      params.location.boundaryRoot === getOpenClawPackageRoot()
        ? "OpenClaw package root"
        : (() => {
            const bundledDir = resolveBundledPluginsDir();
            return bundledDir &&
              path.resolve(params.location.boundaryRoot) === path.resolve(bundledDir)
              ? "bundled plugin directory"
              : "plugin root";
          })(),
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Unable to open bundled plugin public surface ${params.location.modulePath}`, {
      cause: opened.error,
    });
  }
  fs.closeSync(opened.fd);

  const sentinel = {} as T;
  loadedFacadeModules.set(params.location.modulePath, sentinel);

  let loaded: T;
  try {
    loaded =
      params.loadModule?.(params.location.modulePath) ??
      (getJiti(params.location.modulePath)(params.location.modulePath) as T);
    Object.assign(sentinel, loaded);
    loadedFacadePluginIds.add(
      typeof params.trackedPluginId === "function"
        ? params.trackedPluginId()
        : params.trackedPluginId,
    );
  } catch (err) {
    loadedFacadeModules.delete(params.location.modulePath);
    throw err;
  }

  return sentinel;
}

export function loadBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  trackedPluginId?: string | (() => string);
}): T {
  const location = resolveFacadeModuleLocation(params);
  if (!location) {
    throw new Error(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  return loadFacadeModuleAtLocationSync({
    location,
    trackedPluginId: params.trackedPluginId ?? params.dirName,
  });
}

export function listImportedBundledPluginFacadeIds(): string[] {
  return [...loadedFacadePluginIds].toSorted((left, right) => left.localeCompare(right));
}

export function resetFacadeLoaderStateForTest(): void {
  loadedFacadeModules.clear();
  loadedFacadePluginIds.clear();
  jitiLoaders.clear();
  cachedFacadeModuleLocationsByKey.clear();
  facadeLoaderJitiFactory = undefined;
  sdkAliasRuntimeModule = undefined;
  publicSurfaceRuntimeModule = undefined;
  boundaryFileRuntimeModule = undefined;
  cachedOpenClawPackageRoot = undefined;
}
