/** Caches plugin module loaders and native-load stats for runtime/source module imports. */
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { createJiti } from "./jiti-factory.js";
import {
  clearPluginModuleRequireCache,
  isPluginSourceModulePath,
  tryNativeRequireJavaScriptModule,
  tryNativeRequireModule,
} from "./native-module-require.js";
import { isPathInside, openPluginRootFileSync } from "./path-safety.js";
import type { PluginModuleLoader } from "./plugin-cache-artifacts.js";
import {
  bindPluginCacheRoot,
  getPluginCache,
  getPluginCacheRoot,
  getPluginCacheSource,
  withPluginCache,
} from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { installOpenClawInternalCorePackageNativeResolver } from "./plugin-sdk-native-resolver.js";
import { visitPluginSourceReferences } from "./plugin-source-references.js";
import { resolvePluginRuntimeRecord } from "./runtime-context.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import {
  buildPluginLoaderJitiOptions,
  createPluginLoaderModuleCacheKey,
  preparePluginLoaderAliases,
  isPluginSdkAliasSpecifier,
  resolvePluginLoaderTryNative,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";

export type PluginModuleLoaderFactory = typeof createJiti;
type ResolvePluginModuleLoaderCacheEntryParams = {
  modulePath: string;
  importerUrl: string;
  argvEntry?: string;
  preferBuiltDist?: boolean;
  loaderFilename?: string;
  aliasMap?: Record<string, string>;
  tryNative?: boolean;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cacheScopeKey?: string;
  transformOpenClawDependencies?: boolean;
};
const MAX_TRACKED_SOURCE_TRANSFORM_TARGETS = 24;
const pluginModuleLoaderStats = {
  calls: 0,
  nativeHits: 0,
  nativeMisses: 0,
  sourceTransformForced: 0,
  sourceTransformFallbacks: 0,
  sourceTransformTargets: new Map<string, number>(),
};

function recordSourceTransformTarget(target: string): void {
  const current = pluginModuleLoaderStats.sourceTransformTargets.get(target) ?? 0;
  pluginModuleLoaderStats.sourceTransformTargets.set(target, current + 1);
  if (pluginModuleLoaderStats.sourceTransformTargets.size <= MAX_TRACKED_SOURCE_TRANSFORM_TARGETS) {
    return;
  }
  const [leastUsedTarget] = [...pluginModuleLoaderStats.sourceTransformTargets].reduce(
    (least, entry) => (entry[1] < least[1] ? entry : least),
  );
  pluginModuleLoaderStats.sourceTransformTargets.delete(leastUsedTarget);
}

/** Returns process-local plugin module loader stats for diagnostics and tests. */
export function getPluginModuleLoaderStats() {
  const { sourceTransformTargets, ...stats } = pluginModuleLoaderStats;
  return {
    ...stats,
    topSourceTransformTargets: [...sourceTransformTargets]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([target, count]) => ({ target, count })),
  };
}

function toSourceTransformImportPath(specifier: string): string {
  if (process.platform === "win32" && path.isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return toSafeImportPath(specifier);
}

function resolveAutomaticJitiTsconfig(loaderFilename: string): string | undefined {
  const enabled = process.env.JITI_TSCONFIG_PATHS;
  if (enabled !== "1" && enabled !== "true") {
    return undefined;
  }
  let directory = path.dirname(loaderFilename);
  while (true) {
    const config = path.join(directory, "tsconfig.json");
    if (fs.existsSync(config)) {
      return config;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

type BabelImportCallPath = {
  node: {
    callee: { type: string; name?: string };
    arguments: unknown[];
  };
  scope: { getBinding(name: string): unknown };
  replaceWith(node: unknown): void;
};

type BabelProgramPath = {
  scope: { generateUidIdentifier(name: string): { name: string } };
  traverse(visitor: { CallExpression(call: BabelImportCallPath): void }): void;
  unshiftContainer(name: "body", nodes: unknown): void;
};

function createBunJitiImportCachePlugin(babel: {
  types: {
    callExpression(callee: unknown, args: unknown[]): unknown;
    identifier(name: string): unknown;
  };
  template: { statements: { ast(source: string): unknown } };
}) {
  return {
    visitor: {
      Program: {
        exit(program: BabelProgramPath) {
          const calls: BabelImportCallPath[] = [];
          program.traverse({
            CallExpression(call) {
              if (
                call.node.callee.type === "Identifier" &&
                call.node.callee.name === "jitiImport" &&
                !call.scope.getBinding("jitiImport")
              ) {
                calls.push(call);
              }
            },
          });
          if (calls.length === 0) {
            return;
          }
          const cache = program.scope.generateUidIdentifier("openclawJitiImports");
          const load = program.scope.generateUidIdentifier("openclawJitiImport");
          for (const call of calls) {
            call.replaceWith(
              babel.types.callExpression(babel.types.identifier(load.name), call.node.arguments),
            );
          }
          program.unshiftContainer(
            "body",
            babel.template.statements.ast(`
              var ${cache.name};
              function ${load.name}(specifier, ...args) {
                let entry = ${cache.name};
                while (entry) {
                  if (entry.specifier === specifier) {
                    return entry.pending;
                  }
                  entry = entry.next;
                }
                const pending = (async () => {
                  await 0;
                  return jitiImport(specifier, ...args);
                })();
                ${cache.name} = { specifier, pending, next: ${cache.name} };
                return pending;
              }
            `),
          );
        },
      },
    },
  };
}

function preserveBunJitiDynamicImportResults(loader: ReturnType<typeof createJiti>): void {
  if (!process.versions.bun || typeof loader.options?.transform !== "function") {
    return;
  }
  const transform = loader.options.transform;
  loader.options.transform = (options) =>
    transform({
      ...options,
      babel: {
        ...options.babel,
        plugins: [
          ...(Array.isArray(options.babel?.plugins) ? options.babel.plugins : []),
          createBunJitiImportCachePlugin,
        ],
      },
    });
}

function resolvePluginModuleLoaderCacheEntry(params: ResolvePluginModuleLoaderCacheEntryParams) {
  const loaderFilename = toSafeImportPath(params.loaderFilename ?? params.modulePath);
  const tryNative = params.tryNative ?? resolvePluginLoaderTryNative(params.modulePath, params);
  // Explicit maps are content-keyed and captured before a retained loader can escape.
  const explicit = params.aliasMap ? { ...params.aliasMap } : undefined;
  const aliases = explicit
    ? {
        cacheKey: createPluginLoaderModuleCacheKey({ tryNative, aliasMap: explicit }),
        getAliasMap: () => explicit,
        mayResolveSourceSdk: () =>
          Object.entries(explicit).some(
            ([specifier, target]) =>
              isPluginSdkAliasSpecifier(specifier) && isPluginSourceModulePath(target),
          ),
        hasSourceSdkAliases: undefined,
        getSourceTransformAliasMap: () => explicit,
        resolveAlias: (specifier: string) => explicit[specifier],
      }
    : preparePluginLoaderAliases({
        modulePath: params.modulePath,
        argv1: params.argvEntry ?? process.argv[1],
        moduleUrl: params.importerUrl,
        devSourceRoot: params.devSourceRoot,
        pluginSdkResolution: params.pluginSdkResolution,
      });
  const moduleConfigCacheKey = `${tryNative ? "native" : "transform"}\0${aliases.cacheKey}`;
  const lazyNativeAliasFallback = tryNative && typeof Module.registerHooks !== "function";
  const transformOpenClawDependencies =
    params.transformOpenClawDependencies ?? (lazyNativeAliasFallback ? false : tryNative);
  const cacheKey = `${moduleConfigCacheKey}\0transform-openclaw=${transformOpenClawDependencies ? "1" : "0"}`;
  const scopedCacheKey = `${loaderFilename}::${params.cacheScopeKey ? `${params.cacheScopeKey}::` : ""}${cacheKey}`;
  return {
    loaderFilename,
    getAliasMap: aliases.getAliasMap,
    mayResolveSourceSdk: aliases.mayResolveSourceSdk,
    hasSourceSdkAliases: aliases.hasSourceSdkAliases,
    resolveAlias: aliases.resolveAlias,
    tryNative,
    transformOpenClawDependencies,
    sourceTransformAliasMap: lazyNativeAliasFallback
      ? aliases.getSourceTransformAliasMap
      : undefined,
    scopedCacheKey,
  };
}

function createPluginModuleLoader(
  params: ReturnType<typeof resolvePluginModuleLoaderCacheEntry> & {
    createLoader?: PluginModuleLoaderFactory;
    cache: ReturnType<typeof getPluginCache>;
  },
): PluginModuleLoader {
  // A declined native require can leave an ESM dependency in flight. The
  // fallback must transform both the entry and OpenClaw SDK dependencies.
  let sourceSdkAliases: boolean | undefined;
  const hasSourceSdkAliases = () =>
    (sourceSdkAliases ??=
      params.hasSourceSdkAliases?.() ??
      Object.entries(params.getAliasMap()).some(
        ([specifier, target]) =>
          isPluginSdkAliasSpecifier(specifier) && isPluginSourceModulePath(target),
      ));
  const sourceSdkReferences = new Map<string, boolean>();
  const referencesSourceSdk = (target: string) => {
    const cached = sourceSdkReferences.get(target);
    if (cached !== undefined) {
      return cached;
    }
    let found = false;
    try {
      const source = target.startsWith("file:") ? fileURLToPath(target) : target;
      const sourceText = fs.readFileSync(source, "utf8");
      if (!sourceText.includes("plugin-sdk/")) {
        sourceSdkReferences.set(target, false);
        return false;
      }
      const resolver = createJiti(source, { fsCache: false, moduleCache: false, tryNative: false });
      visitPluginSourceReferences(source, sourceText, resolver, (specifier, kind) => {
        if (kind === "asset" || !isPluginSdkAliasSpecifier(specifier)) {
          return;
        }
        const sdkTarget = params.resolveAlias(specifier);
        found ||= Boolean(sdkTarget && isPluginSourceModulePath(sdkTarget));
      });
    } catch {
      // Native loading remains the error owner when source inspection is unavailable.
    }
    sourceSdkReferences.set(target, found);
    return found;
  };
  const requiresSourceSdkTransform = (target: string) =>
    !process.versions.bun &&
    // Absence is enough to skip parsing; positive classification must stay demand-driven.
    params.mayResolveSourceSdk() &&
    referencesSourceSdk(target) &&
    hasSourceSdkAliases();
  let loadWithSourceTransform: PluginModuleLoader | undefined;
  const getLoadWithSourceTransform = () => {
    if (loadWithSourceTransform) {
      return loadWithSourceTransform;
    }
    const aliasMap = params.sourceTransformAliasMap?.() ?? params.getAliasMap();
    const jitiOptions = buildPluginLoaderJitiOptions(aliasMap, {
      modulePath: params.loaderFilename,
    });
    const automaticTsconfig = resolveAutomaticJitiTsconfig(params.loaderFilename);
    const jitiLoader = (params.createLoader ?? createJiti)(params.loaderFilename, {
      ...jitiOptions,
      ...(automaticTsconfig ? { tsconfigPaths: automaticTsconfig } : {}),
      // Source SDK aliases resolve outside node_modules, so Jiti's nativeModules
      // matcher misses them. Keep host state native while plugin source remains
      // transformable and reloadable within its cache generation.
      virtualModules: params.transformOpenClawDependencies
        ? undefined
        : new Proxy<Record<string, unknown>>(
            {},
            {
              has(_target, key) {
                return (
                  typeof key === "string" &&
                  isPluginSdkAliasSpecifier(key) &&
                  Boolean(params.resolveAlias(key))
                );
              },
              get(_target, key) {
                const target = typeof key === "string" ? params.resolveAlias(key) : undefined;
                if (!target) {
                  return undefined;
                }
                if (isPluginSourceModulePath(target)) {
                  return jitiLoader(target);
                }
                const native = tryNativeRequireModule(target, {
                  allowWindows: true,
                  aliasMap: params.resolveAlias,
                  fallbackOnMissingDependency: true,
                });
                return native.ok ? native.moduleExport : jitiLoader(target);
              },
            },
          ),
      nativeModules:
        params.transformOpenClawDependencies || (!process.versions.bun && hasSourceSdkAliases())
          ? jitiOptions.nativeModules.filter((moduleName) => moduleName !== "openclaw")
          : jitiOptions.nativeModules,
      tryNative: false,
    });
    preserveBunJitiDynamicImportResults(jitiLoader);
    loadWithSourceTransform = (target) => jitiLoader(toSourceTransformImportPath(target));
    return loadWithSourceTransform;
  };
  // Prefer native compiled JS, but preserve caller-requested transforms for alias rewrites.
  return (target) => {
    const source = getPluginCacheSource(target, params.cache);
    const cached = source.variants.get(params.scopedCacheKey)?.exports;
    if (cached) {
      return cached.value;
    }
    // Lazy transforms and nested imports must read the creating generation,
    // even when a retained loader is invoked from a newer operation scope.
    const loaded = withPluginCache(params.cache, () => {
      pluginModuleLoaderStats.calls += 1;
      if (params.tryNative && !requiresSourceSdkTransform(target)) {
        const native = tryNativeRequireJavaScriptModule(target, {
          allowWindows: true,
          aliasMap: params.resolveAlias,
          fallbackOnMissingDependency: true,
        });
        if (native.ok) {
          pluginModuleLoaderStats.nativeHits += 1;
          return native.moduleExport;
        }
        pluginModuleLoaderStats.nativeMisses += 1;
        pluginModuleLoaderStats.sourceTransformFallbacks += 1;
      } else {
        // Jiti shares Node's CJS cache, but native ESM chunks are not in it.
        // Explicit source-transform callers keep their graph separate from native loads.
        pluginModuleLoaderStats.sourceTransformForced += 1;
      }
      recordSourceTransformTarget(target);
      return getLoadWithSourceTransform()(target);
    });
    source.variants.set(params.scopedCacheKey, { exports: { value: loaded } });
    return loaded;
  };
}

export function getCachedPluginModuleLoader(
  params: ResolvePluginModuleLoaderCacheEntryParams & {
    createLoader?: PluginModuleLoaderFactory;
  },
): PluginModuleLoader {
  const cacheEntry = resolvePluginModuleLoaderCacheEntry(params);
  const cache = getPluginCache();
  const cached = cache.moduleLoaders.get(cacheEntry.scopedCacheKey);
  if (cached) {
    return cached;
  }
  // Exact-key hits already own the native aliases installed with their loader;
  // reinstallation would rescan the host package on every cached request.
  installOpenClawInternalCorePackageNativeResolver({ moduleUrl: params.importerUrl });
  const loader = createPluginModuleLoader({
    ...cacheEntry,
    cache,
    ...(params.createLoader ? { createLoader: params.createLoader } : {}),
  });
  cache.moduleLoaders.set(cacheEntry.scopedCacheKey, loader);
  return loader;
}

type PluginModuleBoundaryParams = {
  origin?: PluginOrigin;
  modulePath: string;
  boundaryRoot: string;
  boundaryLabel: string;
  rejectHardlinks: boolean;
  surfaceLabel: string;
  pluginId?: string;
};

function resolvePublicSurfaceInstance(params: PluginModuleBoundaryParams) {
  if (
    !isPathInside(params.boundaryRoot, params.modulePath) &&
    !isPathInside(getPluginCacheRoot(params.boundaryRoot).rootDir, params.modulePath)
  ) {
    throw new Error(`Unable to open ${params.surfaceLabel}: outside ${params.boundaryLabel}`);
  }
  const owner = resolvePluginRuntimeRecord(params);
  const instance = owner ? getPluginInstance(owner) : undefined;
  // Core-shipped libraries also serve config/doctor inspection while disabled.
  // Captured source membership stays authoritative even after its files disappear.
  if (
    (owner?.origin ?? params.origin) === "bundled" &&
    (owner?.status !== "loaded" || instance?.hasModuleSource(params.modulePath) === undefined)
  ) {
    return undefined;
  }
  if (!owner || owner.status !== "loaded") {
    if (getPluginRuntimeGatewayRequestScope()?.pluginRegistry) {
      throw new Error(`Plugin public surface ${params.modulePath} has no active runtime owner.`);
    }
    return undefined;
  }
  if (!instance) {
    throw new Error(`Plugin ${owner.id} has no runtime module owner`);
  }
  return instance;
}

/** Validates an entry once per generation without changing its module export shape. */
export function preparePluginModule(params: PluginModuleBoundaryParams) {
  const cache = getPluginCache();
  let source = getPluginCacheSource(params.modulePath, cache);
  const boundaryKey = `${getPluginCacheRoot(params.boundaryRoot).rootDir}\0${params.rejectHardlinks}`;
  if (source.validatedBoundaries.has(boundaryKey)) {
    return { source, modulePath: source.modulePath ?? params.modulePath };
  }
  const opened = openPluginRootFileSync({
    filePath: params.modulePath,
    rootPath: params.boundaryRoot,
    boundaryLabel: params.boundaryLabel,
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!opened.ok) {
    throw new Error(`Unable to open ${params.surfaceLabel}`, { cause: opened.error });
  }
  fs.closeSync(opened.fd);
  if (!sameFileIdentity(opened.stat, fs.statSync(opened.path))) {
    throw new Error(`${params.surfaceLabel} changed after validation`);
  }
  const root = bindPluginCacheRoot(params.boundaryRoot, opened.rootRealPath);
  // Facades reuse the first checked root classification. Explicit stricter
  // callers still validate their own policy through validatedBoundaries above.
  root.publicSurfaceBoundary ??= {
    boundaryLabel: params.boundaryLabel,
    rejectHardlinks: params.rejectHardlinks,
  };
  cache.sourceAliases.set(path.resolve(params.modulePath), opened.path);
  source = getPluginCacheSource(opened.path, cache);
  source.modulePath = opened.path;
  source.validatedBoundaries.add(`${opened.rootRealPath}\0${params.rejectHardlinks}`);
  return { source, modulePath: opened.path };
}

/** Public artifacts and SDK facades share one validated module, including circular imports. */
export function loadPluginPublicSurfaceModuleSync(
  params: PluginModuleBoundaryParams & {
    loadModule: (modulePath: string) => unknown;
  },
): object {
  const instance = resolvePublicSurfaceInstance(params);
  if (instance) {
    // SAFETY: Public-surface entrypoints have object exports; the instance owns this exact source.
    return instance.loadModule(params.modulePath) as object;
  }
  const { source, modulePath } = preparePluginModule(params);
  const cached = source.publicSurface?.exports;
  if (cached) {
    return cached;
  }
  const sentinel: Record<string, unknown> = {};
  const boundaryRoot = getPluginCacheRoot(params.boundaryRoot).rootDir;
  source.disposeModule ??= () => clearPluginModuleRequireCache(modulePath, boundaryRoot);
  source.publicSurface = { exports: sentinel };
  try {
    Object.assign(sentinel, params.loadModule(modulePath));
    return sentinel;
  } catch (error) {
    delete source.publicSurface;
    source.validatedBoundaries.clear();
    throw error;
  }
}
