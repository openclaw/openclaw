/** Caches plugin module loaders and native-load stats for runtime/source module imports. */
import fs from "node:fs";
import Module, { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JitiOptions, JitiResolveOptions } from "jiti";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import { isPathInside } from "../infra/path-guards.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { createJiti } from "./jiti-factory.js";
import {
  clearPluginModuleRequireCache,
  isPluginSourceModulePath,
  tryNativeRequireJavaScriptModule,
  tryNativeRequireModule,
} from "./native-module-require.js";
import type { PluginModuleLoader } from "./plugin-cache-artifacts.js";
import {
  bindPluginCacheRoot,
  getPluginCache,
  getPluginCacheRoot,
  getPluginCacheSource,
  withPluginCache,
} from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginModuleLoaderOwner } from "./plugin-instance.types.js";
import { bindNativePluginInstanceModuleLoader } from "./plugin-native-module-loader.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import {
  installOpenClawInternalCorePackageNativeResolver,
  installOpenClawPluginSdkNativeResolver,
} from "./plugin-sdk-native-resolver.js";
import {
  buildPluginTypeScriptSource,
  PLUGIN_SOURCE_RESOLVE_PREFIX,
  type PluginSourceFile,
  type PluginSourceLoadMode,
} from "./plugin-source-build.js";
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

function resolvePluginModuleLoaderCacheEntry(params: ResolvePluginModuleLoaderCacheEntryParams) {
  const loaderFilename = toSafeImportPath(params.loaderFilename ?? params.modulePath);
  const tryNative = params.tryNative ?? resolvePluginLoaderTryNative(params.modulePath, params);
  // Explicit maps are content-keyed and captured before a retained loader can escape.
  const explicit = params.aliasMap ? { ...params.aliasMap } : undefined;
  const aliases = explicit
    ? {
        cacheKey: createPluginLoaderModuleCacheKey({ tryNative, aliasMap: explicit }),
        getAliasMap: () => explicit,
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
  let loadWithSourceTransform: PluginModuleLoader | undefined;
  const getLoadWithSourceTransform = () => {
    if (loadWithSourceTransform) {
      return loadWithSourceTransform;
    }
    const jitiOptions = buildPluginLoaderJitiOptions(
      params.sourceTransformAliasMap?.() ?? params.getAliasMap(),
      {
        modulePath: params.loaderFilename,
      },
    );
    const jitiLoader = (params.createLoader ?? createJiti)(params.loaderFilename, {
      ...jitiOptions,
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
                const native = tryNativeRequireModule(target, {
                  allowWindows: true,
                  fallbackOnMissingDependency: true,
                });
                return native.ok ? native.moduleExport : jitiLoader(target);
              },
            },
          ),
      nativeModules: params.transformOpenClawDependencies
        ? jitiOptions.nativeModules.filter((moduleName) => moduleName !== "openclaw")
        : jitiOptions.nativeModules,
      tryNative: false,
    });
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
      if (params.tryNative) {
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

/** Runtime and setup instances share the same captured source loader. */
export function bindPluginInstanceModuleLoader(params: {
  instance: PluginModuleLoaderOwner;
  origin: PluginOrigin;
  source: string;
  rootDir: string;
  devSourceRoot?: string | null;
  standalone?: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  inputBoundaryRoot?: string;
  expectedSourceDigest?: string;
}): void {
  const cache = getPluginCache();
  const nativeHooks = typeof Module.registerHooks === "function";
  if (!nativeHooks && params.expectedSourceDigest !== undefined) {
    throw new Error(
      "Source-validated plugin reload requires Node.js module hooks; run the Gateway with Node.js.",
    );
  }
  const sourceBuilds = new Map<string, ReturnType<typeof buildPluginTypeScriptSource>>();
  const sourceForOutput = (filename: string): PluginSourceFile => {
    for (const build of sourceBuilds.values()) {
      const source = build.sourceForOutput(filename);
      if (source) {
        return source;
      }
    }
    return { source: filename };
  };
  const artifact = capturePluginGenerationArtifact(
    params.rootDir,
    params.standalone ? params.source : undefined,
    params.inputBoundaryRoot,
    (run) => params.instance.run(run),
    (filename) => {
      const entry = sourceForOutput(filename);
      return entry.generated ? filename : entry.source;
    },
  );
  if (
    params.expectedSourceDigest !== undefined &&
    artifact.sourceDigest !== params.expectedSourceDigest
  ) {
    artifact.dispose();
    throw new Error(
      `Plugin ${params.instance.pluginId} source changed after installation; inspect it before reloading.`,
    );
  }
  bindPluginCacheRoot(params.rootDir, artifact.sourceRoot);
  if (nativeHooks) {
    params.instance.sourceDigest = artifact.sourceDigest;
  }
  params.instance.lifecycle.onDispose(artifact.dispose);
  const nativeAliases = nativeHooks
    ? undefined
    : preparePluginLoaderAliases({
        modulePath: params.source,
        argv1: process.argv[1],
        moduleUrl: import.meta.url,
        pluginSdkResolution: params.pluginSdkResolution,
        devSourceRoot: params.devSourceRoot,
      });
  if (nativeAliases?.packageRoot) {
    artifact.linkHost(nativeAliases.packageRoot);
  }
  if (nativeAliases) {
    artifact.prepareNativeScopes();
  }
  installOpenClawPluginSdkNativeResolver({
    moduleUrl: import.meta.url,
    pluginModulePath: params.source,
    devSourceRoot: params.devSourceRoot,
    allowedParentRoots: [artifact.boundaryRoot],
  });
  if (nativeAliases) {
    const loader = getCachedPluginModuleLoader({
      modulePath: params.source,
      importerUrl: import.meta.url,
      devSourceRoot: params.devSourceRoot,
      pluginSdkResolution: params.pluginSdkResolution,
      aliasMap: {
        ...nativeAliases.getAliasMap(),
        ...artifact.sourceAliases,
      },
    });
    bindNativePluginInstanceModuleLoader(params, cache, artifact, loader, nativeAliases.sdkRoots);
    return;
  }
  const nativeRequire = createRequire(params.source);
  const createPaths = (source: string, options?: JitiOptions) => ({
    resolver: createJiti(source, {
      ...options,
      fsCache: false,
      moduleCache: false,
      alias: artifact.sourceAliases,
    }),
    targets: new Map<string, string | undefined>(),
  });
  // Match startup's config selection once; unused parents must not validate their configs eagerly.
  const entryPaths = createPaths(params.source);
  const pathResolvers = new Map([[artifact.resolve(params.source), entryPaths]]);
  const tsconfigPaths = entryPaths.resolver.options.tsconfigPaths;
  const demandedModules = new Map<string, { url: string } | { error: unknown }>();
  let resolvingPaths = false;
  params.instance.lifecycle.onDispose(() => {
    for (const build of sourceBuilds.values()) {
      build.dispose();
    }
  });
  const includeSources = (additions: readonly string[]) => {
    for (const build of sourceBuilds.values()) {
      build.include(additions);
    }
  };
  const prepareSource = (
    filename: string,
    mode?: PluginSourceLoadMode,
    nativeFormat?: string | null,
  ) => {
    const root = artifact.moduleRoot(filename);
    if (!root) {
      return filename;
    }
    return params.instance.run(() => {
      let build = sourceBuilds.get(root);
      if (!build) {
        build = buildPluginTypeScriptSource(root);
        sourceBuilds.set(root, build);
      }
      return build.resolve(filename, mode, nativeFormat);
    });
  };
  const hooks = Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      // Lazy native imports outlive the binding call. Only this graph's importers
      // borrow its SDK alias cache; callbacks may otherwise use a newer registry.
      const parent = context.parentURL;
      const parentEntry = parent?.startsWith("file:")
        ? sourceForOutput(fileURLToPath(parent))
        : undefined;
      const parentSource = parentEntry?.source;
      const parentRoot = parentSource && artifact.moduleRoot(parentSource);
      const resolverSource =
        parentEntry?.generated && parentSource && artifact.sourceForCaptured(parentSource);
      // Generated helpers forward Jiti-only resolver options through this instance's owner.
      // Resolve-only replies carry no module execution or new global callback lifetime.
      if (
        resolverSource &&
        parentSource &&
        parentRoot &&
        specifier.startsWith(PLUGIN_SOURCE_RESOLVE_PREFIX)
      ) {
        return params.instance.run(() => {
          // SAFETY: Generated resolver requests always encode this request/options tuple.
          const [request, options] = JSON.parse(
            decodeURIComponent(specifier.slice(PLUGIN_SOURCE_RESOLVE_PREFIX.length)),
          ) as [string, string | JitiResolveOptions];
          const query = typeof options === "string" ? { parentURL: options } : options;
          includeSources(artifact.prepareDependency(parentSource, request));
          let paths = pathResolvers.get(parentSource);
          if (!paths) {
            paths = createPaths(resolverSource, entryPaths.resolver.options);
            pathResolvers.set(parentSource, paths);
          }
          const value = paths.resolver.esmResolve(request, {
            parentURL: pathToFileURL(parentSource),
            ...query,
          });
          return {
            shortCircuit: true,
            url: "data:application/json," + encodeURIComponent(JSON.stringify({ value })),
          };
        });
      }
      // Generated files resolve imports from their captured source's package and directory.
      const nativeContext =
        parentSource && parentRoot
          ? { ...context, parentURL: pathToFileURL(parentSource).href }
          : context;
      const sourceMode = !parentRoot
        ? undefined
        : parentEntry?.mode && parentEntry.mode !== "native"
          ? context.conditions.includes("require")
            ? "sync"
            : "async"
          : "native";
      let resolved =
        parentSource && parentRoot
          ? params.instance.run(() =>
              withPluginCache(cache, () => {
                if (
                  tsconfigPaths &&
                  !resolvingPaths &&
                  !isBuiltin(specifier) &&
                  !isPluginSdkAliasSpecifier(specifier) &&
                  !specifier.startsWith(".") &&
                  !specifier.startsWith("file:") &&
                  !path.isAbsolute(specifier)
                ) {
                  let paths = pathResolvers.get(parentSource);
                  if (!paths) {
                    const original = artifact.sourceForCaptured(parentSource);
                    if (!original) {
                      return nextResolve(specifier, nativeContext);
                    }
                    paths = createPaths(original, entryPaths.resolver.options);
                    pathResolvers.set(parentSource, paths);
                  }
                  const key = JSON.stringify([specifier, context.conditions]);
                  if (!paths.targets.has(key)) {
                    // Jiti's resolution-only native fallback can reenter these same Node hooks.
                    resolvingPaths = true;
                    try {
                      paths.targets.set(
                        key,
                        paths.resolver.esmResolve(specifier, {
                          parentURL: pathToFileURL(parentSource),
                          conditions: [...context.conditions],
                          try: true,
                        }),
                      );
                    } finally {
                      resolvingPaths = false;
                    }
                  }
                  const target = paths.targets.get(key);
                  if (target?.startsWith("file:")) {
                    const filename = fileURLToPath(target);
                    const captured = artifact.hasSource(filename)
                      ? artifact.resolve(filename)
                      : filename;
                    if (artifact.sourceForCaptured(captured)) {
                      return { shortCircuit: true, url: pathToFileURL(captured).href };
                    }
                  }
                }
                const key = JSON.stringify([parentSource, specifier, context.conditions]);
                const demanded = demandedModules.get(key);
                if (demanded) {
                  if ("error" in demanded) {
                    throw demanded.error;
                  }
                  return { shortCircuit: true, url: demanded.url };
                }
                // A captured ancestor can contain another version; prepare this importer's lookup first.
                includeSources(artifact.prepareDependency(parentSource, specifier));
                let resolutionFailure: unknown;
                try {
                  const native = nextResolve(specifier, nativeContext);
                  if (
                    !(specifier.startsWith("file:") || path.isAbsolute(specifier)) ||
                    !native.url.startsWith("file:") ||
                    artifact.moduleRoot(sourceForOutput(fileURLToPath(native.url)).source)
                  ) {
                    return native;
                  }
                  resolutionFailure = new Error(`Plugin module ${specifier} was not captured`);
                } catch (error) {
                  if (
                    isBuiltin(specifier) ||
                    isPluginSdkAliasSpecifier(specifier) ||
                    !(error instanceof Error) ||
                    !("code" in error) ||
                    (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_MODULE_NOT_FOUND")
                  ) {
                    throw error;
                  }
                  resolutionFailure = error;
                }
                try {
                  const captured = artifact.captureModule(
                    parentSource,
                    specifier,
                    context.conditions,
                  );
                  if (!captured) {
                    throw resolutionFailure;
                  }
                  includeSources(captured.additions);
                  if ("retryNative" in captured) {
                    const native = nextResolve(specifier, nativeContext);
                    demandedModules.set(key, { url: native.url });
                    return native;
                  }
                  const filename = fileURLToPath(captured.target);
                  const target =
                    (isPluginSourceModulePath(filename) || filename.endsWith(".jsx")) &&
                    artifact.moduleRoot(filename)
                      ? prepareSource(
                          filename,
                          sourceMode,
                          sourceMode === "native"
                            ? nextResolve(
                                context.conditions.includes("require")
                                  ? filename
                                  : pathToFileURL(filename).href,
                                nativeContext,
                              ).format
                            : undefined,
                        )
                      : filename;
                  captured.target.pathname = pathToFileURL(target).pathname;
                  const url = captured.target.href;
                  demandedModules.set(key, { url });
                  return { shortCircuit: true, url };
                } catch (captureError) {
                  demandedModules.set(key, { error: captureError });
                  throw captureError;
                }
              }),
            )
          : nextResolve(specifier, nativeContext);
      if (resolved.url.startsWith("file:")) {
        const resolvedFilename = fileURLToPath(resolved.url);
        const entry = sourceForOutput(resolvedFilename);
        const filename = entry.generated ? resolvedFilename : entry.source;
        const attributes = resolved.importAttributes ?? context.importAttributes;
        if (
          filename.endsWith(".json") &&
          parentRoot &&
          parentEntry?.mode &&
          (resolved.format === undefined || resolved.format === "json") &&
          attributes &&
          !Object.hasOwn(attributes, "type")
        ) {
          resolved = { ...resolved, importAttributes: { ...attributes, type: "json" } };
        }
        artifact.assertModuleAvailable(filename);
        const additions = artifact.prepareModule(filename);
        includeSources(additions);
        if (
          (isPluginSourceModulePath(filename) || filename.endsWith(".jsx")) &&
          artifact.moduleRoot(filename)
        ) {
          const url = new URL(resolved.url);
          url.pathname = pathToFileURL(
            prepareSource(filename, sourceMode, resolved.format),
          ).pathname;
          return { ...resolved, url: url.href };
        }
      }
      return resolved;
    },
  });
  params.instance.lifecycle.onDispose(() => hooks.deregister());
  const results = new Map<string, { value: unknown } | { error: unknown }>();
  params.instance.bindModuleLoader(
    (source) =>
      withPluginCache(cache, () => {
        const captured = artifact.resolve(source);
        let result = results.get(captured);
        if (!result) {
          try {
            const target =
              isPluginSourceModulePath(captured) || captured.endsWith(".jsx")
                ? prepareSource(captured, "sync")
                : captured;
            result = { value: nativeRequire(target) };
          } catch (error) {
            result = { error };
          }
          // Evaluation may have effects before failing. Never retry this entry through another loader.
          results.set(captured, result);
        }
        if ("error" in result) {
          throw result.error;
        }
        return result.value;
      }),
    artifact.hasSource,
  );
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
  const opened = openRootFileSync({
    absolutePath: params.modulePath,
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
