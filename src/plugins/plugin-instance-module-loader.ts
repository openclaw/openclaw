import fs from "node:fs";
import Module, { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JitiOptions, JitiResolveOptions } from "jiti";
import { isPathInside } from "../infra/path-guards.js";
import { createJiti } from "./jiti-factory.js";
import {
  isJavaScriptModulePath,
  resolvePluginLoaderTryNative,
  isPluginSourceModulePath,
  supportsBunRuntimeOnResolveTargets,
} from "./native-module-require.js";
import type { PluginModuleLoader } from "./plugin-cache-artifacts.js";
import { bindPluginCacheRoot, getPluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import {
  preparePluginModuleLoaderRecovery,
  type PluginInstanceModuleLoaderParams,
} from "./plugin-module-loader-recovery.js";
import { bindNativePluginInstanceModuleLoader } from "./plugin-native-module-loader.js";
import { installOpenClawPluginSdkNativeResolver } from "./plugin-sdk-native-resolver.js";
import { bindSharedPluginModuleLoader } from "./plugin-shared-module-loader.js";
import {
  buildPluginTypeScriptSource,
  PLUGIN_SOURCE_RESOLVE_PREFIX,
  type PluginSourceFile,
  type PluginSourceLoadMode,
} from "./plugin-source-build.js";
import { inspectPluginTypeScriptExecutionFacts } from "./plugin-source-references.js";
import { preparePluginLoaderAliases, isPluginSdkAliasSpecifier } from "./sdk-alias.js";

/** Runtime and setup share code identity policy while keeping separate instance authority. */
export function bindPluginInstanceModuleLoader(params: PluginInstanceModuleLoaderParams): void {
  const cache = getPluginCache();
  if (params.origin === "bundled" && isJavaScriptModulePath(params.source)) {
    if (params.expectedSourceDigest !== undefined) {
      throw new Error("Source digest validation is not applicable to core-bundled runtime modules");
    }
    // Core-shipped code keeps process identity. Recapturing it creates native ESM
    // module jobs that Node retains after the inventory and its callbacks retire.
    let loader: PluginModuleLoader;
    if (params.createHostModuleLoader) {
      loader = params.createHostModuleLoader();
    } else {
      installOpenClawPluginSdkNativeResolver({
        moduleUrl: import.meta.url,
        pluginModulePath: params.source,
        devSourceRoot: params.devSourceRoot,
        pluginSdkResolution: params.pluginSdkResolution,
      });
      loader = getCachedPluginModuleLoader({
        modulePath: params.source,
        importerUrl: import.meta.url,
        devSourceRoot: params.devSourceRoot,
        pluginSdkResolution: params.pluginSdkResolution,
      });
    }
    bindSharedPluginModuleLoader({
      instance: params.instance,
      rootDir: params.rootDir,
      cache,
      loader,
    });
    return;
  }
  const nativeHooks = typeof Module.registerHooks === "function";
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
    (run) => params.instance.run(run),
    (filename) => {
      const entry = sourceForOutput(filename);
      return entry.generated ? filename : entry.source;
    },
    params.nativeRecovery,
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
  params.instance.sourceDigest = artifact.sourceDigest;
  params.instance.onModuleDispose(artifact.disposeAsync);
  const bindModuleLoader = preparePluginModuleLoaderRecovery(
    params,
    artifact,
    bindPluginInstanceModuleLoader,
  );
  const aliases = preparePluginLoaderAliases({
    modulePath: params.source,
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    pluginSdkResolution: params.pluginSdkResolution,
    devSourceRoot: params.devSourceRoot,
  });
  if (aliases.packageRoot) {
    artifact.linkHost(aliases.packageRoot);
  }
  installOpenClawPluginSdkNativeResolver({
    moduleUrl: import.meta.url,
    pluginModulePath: params.source,
    devSourceRoot: params.devSourceRoot,
    allowedParentRoots: [artifact.boundaryRoot],
    pluginSdkResolution: params.pluginSdkResolution,
  });
  if (!nativeHooks) {
    const capturedSource = artifact.resolve(params.source);
    artifact.prepareModule(capturedSource);
    const bunSourceFacts =
      process.versions.bun && isPluginSourceModulePath(params.source)
        ? inspectPluginTypeScriptExecutionFacts(
            params.source,
            fs.readFileSync(params.source, "utf8"),
            createJiti(params.source, { fsCache: false, moduleCache: false, tryNative: false }),
          )
        : undefined;
    for (const { specifier } of bunSourceFacts?.staticImports ?? []) {
      if (path.isAbsolute(specifier) || specifier.startsWith("file:")) {
        artifact.captureModule(capturedSource, specifier, ["node", "import"]);
      }
    }
    const bunNeedsNativeSource =
      Boolean(process.versions.bun) &&
      supportsBunRuntimeOnResolveTargets() &&
      (bunSourceFacts?.hasComputedImport === true ||
        bunSourceFacts?.staticImports.some(
          ({ specifier, sideEffect }) => sideEffect && /\.cjs(?:[?#].*)?$/u.test(specifier),
        ) === true);
    const tryNative =
      process.env.JITI_JSX === "1" || process.env.JITI_JSX === "true"
        ? false
        : (process.versions.bun && artifact.boundaryRoot.includes("\\")) || bunNeedsNativeSource
          ? true
          : undefined;
    const effectiveTryNative = tryNative ?? resolvePluginLoaderTryNative(params.source);
    const loader = getCachedPluginModuleLoader({
      modulePath: params.source,
      importerUrl: import.meta.url,
      devSourceRoot: params.devSourceRoot,
      pluginSdkResolution: params.pluginSdkResolution,
      tryNative,
      aliasMap: {
        ...aliases.getAliasMap(),
        ...artifact.sourceAliases,
      },
    });
    bindNativePluginInstanceModuleLoader(
      { ...params, bindModuleLoader },
      cache,
      artifact,
      loader,
      aliases.sdkRoots,
      !effectiveTryNative,
    );
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
  params.instance.onModuleDispose(() => {
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
          const requestJson = decodeURIComponent(
            specifier.slice(PLUGIN_SOURCE_RESOLVE_PREFIX.length),
          );
          // SAFETY: Generated resolver requests always encode this request/options tuple.
          const [request, options] = JSON.parse(requestJson) as [
            string,
            string | JitiResolveOptions,
          ];
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
                    artifact.moduleRoot(sourceForOutput(fileURLToPath(native.url)).source) ||
                    // Resolved SDK URLs keep host identity just like their public specifiers.
                    aliases.sdkRoots.some((root) => isPathInside(root, fileURLToPath(native.url)))
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
  params.instance.onModuleDispose(() => hooks.deregister());
  const results = new Map<string, { value: unknown } | { error: unknown }>();
  bindModuleLoader(
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
