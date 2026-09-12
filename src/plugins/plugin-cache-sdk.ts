type PluginSdkAliasMap = Record<string, string>;

export type PluginSdkPackageJson = {
  name?: string;
  exports?: Record<string, unknown>;
  bin?: string | Record<string, unknown>;
  version?: string;
};

export type WorkspacePackageAliasEntry = {
  packageName: string;
  packageDir: string;
  subpath: string;
  srcFile: string;
  distFile: string;
};

export type PluginRuntimeModuleResolution = {
  modulePath?: string;
  packageRoot: string | null;
  candidates: string[];
  resolvedPath: string | null;
  error?: string;
};

type PreparedPluginAliases = {
  packageRoot: string | null;
  cacheKey: string;
  sdkRoots: string[];
  getAliasMap: () => PluginSdkAliasMap;
  getSourceTransformAliasMap: () => PluginSdkAliasMap;
  resolveAlias: (specifier: string) => string | undefined;
};

type PluginSdkHostFacts = {
  packageJson?: PluginSdkPackageJson | null;
  nativePackage?: { name?: string; hasOpenClawBin: boolean } | null;
  trustedRoot?: boolean;
  exportedSubpaths?: string[] | null;
  privateSubpaths?: string[];
  workspaceExports: Map<string, WorkspacePackageAliasEntry[]>;
  subpathsByOwner: Map<string, string[]>;
  bundledAliasesByMode: Map<string, PluginSdkAliasMap>;
  workspaceAliasesByMode: Map<string, PluginSdkAliasMap>;
};

/** Derived SDK facts share the plugin cache lifetime; none owns a separate expiry. */
export function createPluginCacheSdk() {
  return {
    hosts: new Map<string, PluginSdkHostFacts>(),
    contexts: new Map<string, PreparedPluginAliases>(),
    packageNames: new Map<string, string | null>(),
    packageSearches: new Map<string, { first?: string | null; all?: string[] }>(),
    argvDirectories: new Map<string, string[]>(),
    devSourceRoots: new Map<string, string | null>(),
    runtimeModules: new Map<string, PluginRuntimeModuleResolution>(),
    usableDistArtifacts: new Map<string, boolean>(),
    normalizedJitiAliases: new Map<string, PluginSdkAliasMap>(),
    aliasFacts: new WeakMap<
      PluginSdkAliasMap,
      {
        normalizedJiti?: PluginSdkAliasMap;
        moduleKey?: string;
      }
    >(),
    native: {
      sdkProviders: new Map<
        string,
        { resolveAlias: (specifier: string) => string | undefined; order?: number }
      >(),
      nextSdkProviderOrder: 0,
      aliases: new Map<string, Array<{ parentRoot: string; target: string }>>(),
      registeredHosts: new Set<string>(),
      hostRoots: new Map<string, string>(),
      nearestPackageRoots: new Map<string, string>(),
      loaderPackageRoots: new Map<string, string>(),
      allowedParentRoots: new Map<string, string>(),
    },
  };
}

export type PluginCacheSdk = ReturnType<typeof createPluginCacheSdk>;

export function getPluginSdkHostFacts(
  cache: PluginCacheSdk,
  packageRoot: string,
): PluginSdkHostFacts {
  let facts = cache.hosts.get(packageRoot);
  if (!facts) {
    facts = {
      workspaceExports: new Map(),
      subpathsByOwner: new Map(),
      bundledAliasesByMode: new Map(),
      workspaceAliasesByMode: new Map(),
    };
    cache.hosts.set(packageRoot, facts);
  }
  return facts;
}
