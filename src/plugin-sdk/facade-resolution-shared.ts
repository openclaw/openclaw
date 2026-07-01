/**
 * Shared resolver for bundled plugin facade module paths and registry fallbacks.
 */
import fs from "node:fs";
import path from "node:path";
import { areBundledPluginsDisabled } from "../plugins/bundled-dir.js";
import {
  PUBLIC_SURFACE_SOURCE_EXTENSIONS,
  normalizeBundledPluginArtifactSubpath,
  resolveBundledPluginPublicSurfacePath,
  resolveBundledPluginSourcePublicSurfacePath,
} from "../plugins/public-surface-runtime.js";

/** Resolved facade module path plus the package/plugin root that bounds imports. */
export type FacadeModuleLocationLike = {
  modulePath: string;
  boundaryRoot: string;
};

export type FacadeRegistryRecordLike = {
  id: string;
  rootDir: string;
  channels: string[];
};

/** Builds the cache key for one facade lookup under the current bundled-plugin mode. */
export function createFacadeResolutionKey(params: {
  dirName: string;
  artifactBasename: string;
  bundledPluginsDir?: string | null;
  env?: NodeJS.ProcessEnv;
}): string {
  const disabledKey = areBundledPluginsDisabled(params.env ?? process.env) ? "disabled" : "enabled";
  return `${params.dirName}::${params.artifactBasename}::${
    params.bundledPluginsDir ? path.resolve(params.bundledPluginsDir) : "<default>"
  }::${disabledKey}`;
}

/** Chooses the boundary root that should constrain a resolved facade module. */
export function resolveFacadeBoundaryRoot(params: {
  modulePath: string;
  bundledPluginsDir?: string | null;
  packageRoot: string;
}): string {
  if (!params.bundledPluginsDir) {
    return params.packageRoot;
  }
  const resolvedBundledPluginsDir = path.resolve(params.bundledPluginsDir);
  return params.modulePath.startsWith(`${resolvedBundledPluginsDir}${path.sep}`)
    ? resolvedBundledPluginsDir
    : params.packageRoot;
}

/** Resolves a bundled facade from source in dev and built artifacts in dist installs. */
export function resolveBundledFacadeModuleLocation(params: {
  currentModulePath: string;
  packageRoot: string;
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
  bundledPluginsDir?: string | null;
}): FacadeModuleLocationLike | null {
  const env = params.env ?? process.env;
  if (areBundledPluginsDisabled(env)) {
    return null;
  }
  const preferSource = !params.currentModulePath.includes(`${path.sep}dist${path.sep}`);
  const packageSourceRoot = path.resolve(params.packageRoot, "extensions");
  const publicSurfaceParams = {
    rootDir: params.packageRoot,
    env: params.env,
    ...(params.bundledPluginsDir ? { bundledPluginsDir: params.bundledPluginsDir } : {}),
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
  };
  const modulePath = preferSource
    ? (resolveBundledPluginSourcePublicSurfacePath({
        dirName: params.dirName,
        artifactBasename: params.artifactBasename,
        sourceRoot: params.bundledPluginsDir ?? packageSourceRoot,
      }) ??
      (params.bundledPluginsDir && !areBundledPluginsDisabled(env)
        ? resolveBundledPluginSourcePublicSurfacePath({
            dirName: params.dirName,
            artifactBasename: params.artifactBasename,
            sourceRoot: packageSourceRoot,
          })
        : null) ??
      resolveBundledPluginPublicSurfacePath(publicSurfaceParams))
    : resolveBundledPluginPublicSurfacePath(publicSurfaceParams);
  return modulePath
    ? {
        modulePath,
        boundaryRoot: resolveFacadeBoundaryRoot({
          modulePath,
          bundledPluginsDir: params.bundledPluginsDir,
          packageRoot: params.packageRoot,
        }),
      }
    : null;
}

/** Resolves a facade path from manifest registry records using id, folder, then channel matches. */
export function resolveRegistryPluginModuleLocationFromRecords(params: {
  registry: readonly FacadeRegistryRecordLike[];
  dirName: string;
  artifactBasename: string;
}): FacadeModuleLocationLike | null {
  const records = params.registry.flatMap((record) => {
    const safeRecord = readFacadeRegistryRecord(record);
    return safeRecord ? [safeRecord] : [];
  });
  const tiers: Array<(plugin: FacadeRegistryRecordLike) => boolean> = [
    (plugin) => plugin.id === params.dirName,
    (plugin) => path.basename(plugin.rootDir) === params.dirName,
    (plugin) => plugin.channels.includes(params.dirName),
  ];
  const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);
  const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
  for (const matchFn of tiers) {
    for (const record of records) {
      if (!matchFn(record)) {
        continue;
      }
      const location = resolveFacadeRegistryRecordLocation({
        record,
        artifactBasename,
        sourceBaseName,
      });
      if (location) {
        return location;
      }
    }
  }
  return null;
}

export function readFacadeRegistryRecord(record: unknown): FacadeRegistryRecordLike | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  try {
    const candidate = record as {
      channels?: unknown;
      id?: unknown;
      rootDir?: unknown;
    };
    const { channels, id, rootDir } = candidate;
    if (typeof id !== "string" || id.length === 0) {
      return null;
    }
    if (typeof rootDir !== "string" || rootDir.length === 0) {
      return null;
    }
    return {
      id,
      rootDir,
      channels: Array.isArray(channels)
        ? channels.filter((channel): channel is string => typeof channel === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function resolveFacadeRegistryRecordLocation(params: {
  record: FacadeRegistryRecordLike;
  artifactBasename: string;
  sourceBaseName: string;
}): FacadeModuleLocationLike | null {
  try {
    const rootDir = path.resolve(params.record.rootDir);
    for (const builtCandidate of [
      path.join(rootDir, params.artifactBasename),
      path.join(rootDir, "dist", params.artifactBasename),
    ]) {
      if (fs.existsSync(builtCandidate)) {
        return { modulePath: builtCandidate, boundaryRoot: rootDir };
      }
    }
    for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
      const sourceCandidate = path.join(rootDir, `${params.sourceBaseName}${ext}`);
      if (fs.existsSync(sourceCandidate)) {
        return { modulePath: sourceCandidate, boundaryRoot: rootDir };
      }
    }
  } catch {
    return null;
  }
  return null;
}
