export type PluginModuleLoader = (target: string) => unknown;

export type InspectionNativeEsmPolicy = {
  workspaces: ReadonlySet<string>;
  sources: ReadonlyMap<string, string>;
  devSourceRoot?: string | null;
};

/** Admission owns the lifetime; the module loader owns concrete code and capture resources. */
export type InspectionNativeEsmRetention = InspectionNativeEsmPolicy & {
  dispose?: () => Promise<void>;
};

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

export type PluginRootArtifactCache = {
  publicSurfaceBoundary?: { boundaryLabel: string; rejectHardlinks: boolean };
  artifactLoadsInProgress: Set<string>;
  /** Immutable artifact facts acquired by one plugin cache generation. */
  artifacts: Map<string, { modulePath: string; boundaryRoot: string } | null>;
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
