/** Immutable artifact facts acquired by one plugin cache generation. */
type PluginArtifactLocation = { modulePath: string; boundaryRoot: string };

export type PluginModuleLoader = (
  target: string,
  retain?: (module: NodeJS.Module | undefined) => void,
) => unknown;

type PluginModuleCacheVariant = {
  exports?: { value: unknown; module?: NodeJS.Module };
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

type PluginRootArtifactCache = {
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

export function createPluginCacheArtifacts(): {
  moduleLoaders: Map<string, PluginModuleLoader>;
  sources: Map<string, PluginSourceCacheRecord>;
  sourceAliases: Map<string, string>;
} {
  return { moduleLoaders: new Map(), sources: new Map(), sourceAliases: new Map() };
}

export function createPluginRootArtifacts(): PluginRootArtifactCache {
  return {
    artifactLoadsInProgress: new Set<string>(),
    artifacts: new Map<string, PluginArtifactLocation | null>(),
    runtimeArtifacts: new Map(),
    entryBoundaries: new Map(),
    entryPaths: new Map(),
  };
}
