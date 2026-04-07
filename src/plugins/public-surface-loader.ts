import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { resolveBundledPluginPublicSurfacePath } from "./public-surface-runtime.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  resolveLoaderPackageRoot,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const loadedPublicSurfaceModules = new Map<string, unknown>();
const publicSurfaceLocations = new Map<
  string,
  {
    modulePath: string;
    boundaryRoot: string;
  } | null
>();
const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();
const sharedBundledPublicSurfaceJitiLoaders = new Map<string, ReturnType<typeof createJiti>>();

function createResolutionKey(params: { dirName: string; artifactBasename: string }): string {
  const bundledPluginsDir = resolveBundledPluginsDir();
  return `${params.dirName}::${params.artifactBasename}::${bundledPluginsDir ? path.resolve(bundledPluginsDir) : "<default>"}`;
}

function resolvePublicSurfaceLocationUncached(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  const bundledPluginsDir = resolveBundledPluginsDir();
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

function resolvePublicSurfaceLocation(params: {
  dirName: string;
  artifactBasename: string;
}): { modulePath: string; boundaryRoot: string } | null {
  const key = createResolutionKey(params);
  if (publicSurfaceLocations.has(key)) {
    return publicSurfaceLocations.get(key) ?? null;
  }
  const resolved = resolvePublicSurfaceLocationUncached(params);
  publicSurfaceLocations.set(key, resolved);
  return resolved;
}

function getJiti(modulePath: string) {
  const tryNative =
    shouldPreferNativeJiti(modulePath) || modulePath.includes(`${path.sep}dist${path.sep}`);
  const sharedLoader = getSharedBundledPublicSurfaceJiti(modulePath, tryNative);
  if (sharedLoader) {
    return sharedLoader;
  }
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

function getSharedBundledPublicSurfaceJiti(
  modulePath: string,
  tryNative: boolean,
): ReturnType<typeof createJiti> | null {
  const bundledPluginsDir = resolveBundledPluginsDir();
  const normalizedModulePath = path.resolve(modulePath);
  const sharedRoots = [
    bundledPluginsDir ? path.resolve(bundledPluginsDir) : null,
    path.join(OPENCLAW_PACKAGE_ROOT, "extensions"),
    path.join(OPENCLAW_PACKAGE_ROOT, "dist", "extensions"),
    path.join(OPENCLAW_PACKAGE_ROOT, "dist-runtime", "extensions"),
  ].filter((root): root is string => typeof root === "string");
  const isBundledPublicSurface = sharedRoots.some(
    (root) =>
      normalizedModulePath === root || normalizedModulePath.startsWith(`${root}${path.sep}`),
  );
  if (!isBundledPublicSurface) {
    return null;
  }
  const cacheKey = tryNative ? "bundled:native" : "bundled:source";
  const cached = sharedBundledPublicSurfaceJitiLoaders.get(cacheKey);
  if (cached) {
    return cached;
  }
  const aliasMap = buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url);
  const loader = createJiti(import.meta.url, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  sharedBundledPublicSurfaceJitiLoaders.set(cacheKey, loader);
  return loader;
}

export function loadBundledPluginPublicArtifactModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
}): T {
  const location = resolvePublicSurfaceLocation(params);
  if (!location) {
    throw new Error(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  const cached = loadedPublicSurfaceModules.get(location.modulePath);
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

  const sentinel = {} as T;
  loadedPublicSurfaceModules.set(location.modulePath, sentinel);
  try {
    const loaded = getJiti(location.modulePath)(location.modulePath) as T;
    Object.assign(sentinel, loaded);
    return sentinel;
  } catch (error) {
    loadedPublicSurfaceModules.delete(location.modulePath);
    throw error;
  }
}

export function resetBundledPluginPublicArtifactLoaderForTest(): void {
  loadedPublicSurfaceModules.clear();
  publicSurfaceLocations.clear();
  jitiLoaders.clear();
  sharedBundledPublicSurfaceJitiLoaders.clear();
}
