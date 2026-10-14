/** Immutable artifact facts acquired by one plugin cache generation. */
type PluginArtifactLocation = { modulePath: string; boundaryRoot: string };

export type PluginModuleLoader = (target: string) => unknown;

type PluginModuleCacheVariant = {
  exports?: { value: unknown };
  pending?: Promise<unknown>;
};

export type PluginSourceCacheRecord = {
  modulePath?: string;
  disposeModule?: () => void;
  variants: Map<string, PluginModuleCacheVariant>;
  validatedBoundaries: Set<string>;
  facadeTracked?: true;
  capabilityCatalog?: {
    context: object;
    value: import("./capability-catalog.types.js").PluginCapabilityCatalog;
  };
  publicSurface?: { exports: object };
};

type PluginPublicSurfaceBoundary = { boundaryLabel: string; rejectHardlinks: boolean };

export type PluginRootArtifactCache = {
  publicSurfaceBoundary?: PluginPublicSurfaceBoundary;
  artifactLoadsInProgress: Set<string>;
  artifacts: Map<string, PluginArtifactLocation | null>;
  runtimeArtifacts: Map<string, { source: string; rootDir: string }>;
  entryBoundaries: Map<
    string,
    {
      importerPath: string;
      importerDir: string;
      boundaryRoot: string;
      packageRoot: string | null;
    }
  >;
  entryPaths: Map<string, { path: string } | { error: Error }>;
};

export type PluginCacheArtifacts = {
  moduleLoaders: Map<string, PluginModuleLoader>;
  sources: Map<string, PluginSourceCacheRecord>;
  sourceAliases: Map<string, string>;
  runtimeRecordRoots: WeakMap<object, { rootDir: string; resolvedRootDir: string; prefix: string }>;
};
