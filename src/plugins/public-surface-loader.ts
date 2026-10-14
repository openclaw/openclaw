// Loads documented plugin public surfaces while preserving lazy boundaries.
import {
  MissingPublicSurfaceError,
  loadFacadeModuleAtLocationSync,
  resolveBundledPublicSurfaceLocation,
  type FacadeModuleLocation,
} from "../plugin-sdk/facade-loader.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  getCachedPluginModuleLoader,
  loadPluginPublicSurfaceModuleSync,
} from "./plugin-module-loader-cache.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import {
  resolvePluginRootPublicSurfacePath,
  resolveRetainedDoctorPath,
} from "./public-surface-runtime.js";

export function loadValidatedPublicSurfaceModule(params: {
  modulePath: string;
  boundaryRoot: string;
  surfaceLabel: string;
  origin: PluginOrigin;
  pluginId?: string;
  /** The caller already owns this immutable module generation, independently of runtime registries. */
  capturedSource?: true;
}): object {
  const boundary = {
    boundaryLabel: "plugin root",
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({
      origin: params.origin,
      rootDir: params.boundaryRoot,
    }),
  };
  if (params.capturedSource) {
    return loadPluginPublicSurfaceModuleSync({
      ...params,
      ...boundary,
      loadModule: (modulePath) =>
        getCachedPluginModuleLoader({
          modulePath,
          importerUrl: import.meta.url,
          preferBuiltDist: true,
          loaderFilename: import.meta.url,
        })(modulePath),
    });
  }
  return loadFacadeModuleAtLocationSync({
    location: params,
    surfaceLabel: params.surfaceLabel,
    pluginId: params.pluginId,
    boundary,
  });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): T {
  const loaded = loadBundledPluginPublicArtifactModuleFromCandidatesSync<T>({
    ...params,
    artifactCandidates: [params.artifactBasename],
  });
  if (!loaded) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  return loaded;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadPluginPublicArtifactModuleSync<T extends object>(params: {
  pluginRoot: string;
  artifactBasename: string;
  origin?: "bundled" | "global";
  pluginId?: string;
}): T {
  const modulePath = resolvePluginRootPublicSurfacePath(params);
  if (!modulePath) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve plugin public surface ${params.pluginRoot}/${params.artifactBasename}`,
    );
  }
  return loadValidatedPublicSurfaceModule({
    modulePath,
    boundaryRoot: params.pluginRoot,
    surfaceLabel: `plugin public surface ${params.artifactBasename}`,
    origin: params.origin ?? "global",
    pluginId: params.pluginId,
  }) as T;
}

/** Loads the first resolvable bundled public artifact from an ordered candidate list. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleFromCandidatesSync<T extends object>(params: {
  dirName: string;
  artifactCandidates: readonly string[];
  env?: NodeJS.ProcessEnv;
  owner?: Pick<PluginManifestRecord, "id" | "rootDir" | "source" | "origin">;
  /** Admission pins host-retained checks to the staged candidate, independently of runtime selection. */
  retainedAt?: string;
}): T | null {
  for (const artifactBasename of params.artifactCandidates) {
    let location: FacadeModuleLocation | null;
    if (params.retainedAt) {
      const modulePath = resolveRetainedDoctorPath({
        rootDir: params.retainedAt,
        dirName: params.dirName,
        artifactBasename,
      });
      location = modulePath
        ? { modulePath, boundaryRoot: params.retainedAt, origin: "bundled" }
        : null;
    } else if (params.owner) {
      const modulePath = resolvePluginRootPublicSurfacePath({
        pluginRoot: params.owner.rootDir,
        pluginId: params.owner.id,
        entrySource: params.owner.source,
        artifactBasename,
      });
      location = modulePath
        ? {
            modulePath,
            boundaryRoot: params.owner.rootDir,
            pluginId: params.owner.id,
            origin: params.owner.origin,
          }
        : null;
    } else {
      location = resolveBundledPublicSurfaceLocation({
        dirName: params.dirName,
        artifactBasename,
        env: params.env,
        preferSource: false,
      });
    }
    if (location) {
      return loadValidatedPublicSurfaceModule({
        ...location,
        surfaceLabel: `bundled plugin public surface ${params.dirName}/${artifactBasename}`,
        origin: location.origin ?? "bundled",
      }) as T;
    }
  }
  return null;
}
