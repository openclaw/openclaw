import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPathInside } from "../infra/path-guards.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Resolution and Jiti must accept the same source family, including typed JSX variants.
export const PLUGIN_SOURCE_MODULE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mtsx",
  ".ctsx",
];

export function isPluginSourceModulePath(modulePath: string): boolean {
  return PLUGIN_SOURCE_MODULE_EXTENSIONS.includes(path.extname(modulePath).toLowerCase());
}

// Failed ESM jobs survive require-cache eviction. Preserve an observed terminal error
// if a retry hits that job, rather than transforming its rejected graph through Jiti.
const nativeModuleLoadFailures = new Map<string, unknown>();
type ResolveFilename = (
  request: string,
  parent: NodeJS.Module | undefined,
  isMain: boolean,
  options?: { paths?: string[] },
) => string;
const moduleWithResolver = Module as typeof Module & {
  _resolveFilename?: ResolveFilename;
  registerHooks?: (options: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string | undefined },
      nextResolve: (
        specifier: string,
        context?: { parentURL?: string | undefined },
      ) => {
        url: string;
      },
    ) => { shortCircuit?: boolean; url: string };
  }) => { deregister: () => void };
};

/** True for file extensions Node can load through the native JS module loader. */
export function isJavaScriptModulePath(modulePath: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(path.extname(modulePath).toLowerCase());
}

function isMissingTargetModuleError(
  error: { code?: unknown; message?: unknown },
  modulePath: string,
): boolean {
  if (error.code !== "MODULE_NOT_FOUND" || typeof error.message !== "string") {
    return false;
  }
  const firstLine = error.message.split("\n", 1)[0] ?? "";
  return firstLine.includes(`'${modulePath}'`) || firstLine.includes(`"${modulePath}"`);
}

function isSourceTransformFallbackError(error: unknown, modulePath: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  const code = candidate.code;
  return (
    code === "ERR_REQUIRE_ESM" ||
    code === "ERR_REQUIRE_ASYNC_MODULE" ||
    code === "ERR_REQUIRE_ESM_RACE_CONDITION" ||
    code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" ||
    code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING" ||
    code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    isMissingTargetModuleError(candidate, modulePath)
  );
}

/** Attempts native require before falling back to source transform paths. */
export function tryNativeRequireJavaScriptModule(
  moduleSpecifier: string,
  options: Parameters<typeof tryNativeRequireModule>[1] = {},
): { ok: true; moduleExport: unknown } | { ok: false } {
  if (!isJavaScriptModulePath(toNativeRequirePath(moduleSpecifier))) {
    return { ok: false };
  }
  return tryNativeRequireModule(moduleSpecifier, options);
}

/** Loads prepared host aliases, including source SDK paths supported by the runtime. */
export function tryNativeRequireModule(
  moduleSpecifier: string,
  options: {
    allowWindows?: boolean;
    aliasMap?: Record<string, string> | ((specifier: string) => string | undefined);
    fallbackOnMissingDependency?: boolean;
    fallbackOnNativeError?: boolean;
  } = {},
): { ok: true; moduleExport: unknown } | { ok: false } {
  if (process.platform === "win32" && options.allowWindows !== true) {
    return { ok: false };
  }
  const modulePath = toNativeRequirePath(moduleSpecifier);
  // A process-wide require retains evicted graphs through its parent's children.
  // Keep that parent scoped to this load so retired graphs can be collected.
  const require = createRequire(import.meta.url);
  if (
    isPluginSourceModulePath(modulePath) &&
    !process.features.typescript &&
    typeof require.extensions?.[path.extname(modulePath)] !== "function"
  ) {
    return { ok: false };
  }
  let resolvedPath = modulePath;
  try {
    const moduleExport = withNativeRequireAliases(options.aliasMap, () => {
      resolvedPath = require.resolve(modulePath);
      // Requiring the resolved target could apply a second alias to the same request.
      return require(modulePath);
    });
    nativeModuleLoadFailures.delete(resolvedPath);
    return { ok: true, moduleExport };
  } catch (error) {
    const code =
      error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (
      nativeModuleLoadFailures.has(resolvedPath) &&
      (code === "ERR_REQUIRE_ESM_RACE_CONDITION" || code === "ERR_INTERNAL_ASSERTION")
    ) {
      throw nativeModuleLoadFailures.get(resolvedPath);
    }
    if (
      isSourceTransformFallbackError(error, modulePath) ||
      options.fallbackOnNativeError ||
      (options.fallbackOnMissingDependency === true &&
        (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND"))
    ) {
      return { ok: false };
    }
    nativeModuleLoadFailures.set(resolvedPath, error);
    throw error;
  }
}

// Native and transformed host helpers share the same native-cache lifetime barrier.
const nativeModuleCache = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginNativeModuleCache"),
  () => ({ activeOwners: 0, retiringModules: new Set<NodeJS.Module>() }),
);

/** Managed loaders retain exact records; Jiti can share children without recording every edge. */
export function createPluginModuleRequireCacheOwner(dependencyRoot: string) {
  const entries = new Set<NodeJS.Module>();
  let disposed = false;
  nativeModuleCache.activeOwners += 1;
  return {
    retain: (module: NodeJS.Module | undefined) => {
      if (module) {
        entries.add(module);
      }
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const seen = new Set<NodeJS.Module>();
      const retire = (module: NodeJS.Module) => {
        if (seen.has(module) || !isPathInside(dependencyRoot, module.id)) {
          return;
        }
        seen.add(module);
        nativeModuleCache.retiringModules.add(module);
        for (const child of module.children) {
          retire(child);
        }
      };
      for (const entry of entries) {
        retire(entry);
      }
      entries.clear();
      // Jiti cache hits omit parent/child edges. Keep native records until every
      // managed native loader closes rather than evicting an unrecorded shared dependency.
      if (--nativeModuleCache.activeOwners !== 0) {
        return;
      }
      const cache = createRequire(import.meta.url).cache;
      for (const module of nativeModuleCache.retiringModules) {
        if (cache[module.id] === module) {
          delete cache[module.id];
        }
      }
      nativeModuleCache.retiringModules.clear();
    },
  };
}

/** Record native cache identity with the load result, before another load can replace it. */
export function getPluginModuleRequireCacheEntry(modulePath: string): NodeJS.Module | undefined {
  const require = createRequire(import.meta.url);
  const filename = toNativeRequirePath(modulePath);
  if (require.cache[filename]) {
    return require.cache[filename];
  }
  try {
    return require.cache[require.resolve(filename)];
  } catch {
    // Custom loaders and native ESM do not necessarily publish a CJS record.
    return undefined;
  }
}

/** Explicit public-library invalidation refreshes the current path synchronously.
 * Managed retirement instead releases exact records through its cache owner above.
 */
export function clearPluginModuleRequireCache(modulePath: string, dependencyRoot: string): void {
  const require = createRequire(import.meta.url);
  const seen = new Set<string>();
  const clear = (id: string) => {
    if (seen.has(id) || !isPathInside(dependencyRoot, id)) {
      return;
    }
    seen.add(id);
    for (const child of require.cache[id]?.children ?? []) {
      clear(child.id);
    }
    delete require.cache[id];
  };
  clear(modulePath);
}

// Native require and cache keys use paths; ESM/source loaders keep URL specifiers.
function toNativeRequirePath(specifier: string): string {
  try {
    return /^file:\/\//iu.test(specifier) ? fileURLToPath(specifier) : specifier;
  } catch {
    return specifier;
  }
}

/** Runs a native require block with temporary CJS/ESM alias hooks and restores both afterward. */
function withNativeRequireAliases<T>(
  aliasMap: Record<string, string> | ((specifier: string) => string | undefined) | undefined,
  run: () => T,
): T {
  if (!aliasMap || !moduleWithResolver["_resolveFilename"]) {
    return run();
  }
  const resolveAlias =
    typeof aliasMap === "function" ? aliasMap : (specifier: string) => aliasMap[specifier];
  const originalResolveFilename = moduleWithResolver["_resolveFilename"];
  const esmHooks = moduleWithResolver.registerHooks?.({
    resolve(specifier, context, nextResolve) {
      const aliasTarget = resolveAlias(specifier);
      if (aliasTarget) {
        return {
          shortCircuit: true,
          url: pathToFileURL(aliasTarget).href,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  moduleWithResolver["_resolveFilename"] = ((request, parent, isMain, options) => {
    const aliasTarget = resolveAlias(request);
    if (aliasTarget) {
      return aliasTarget;
    }
    return originalResolveFilename(request, parent, isMain, options);
  }) satisfies ResolveFilename;
  try {
    return run();
  } finally {
    moduleWithResolver["_resolveFilename"] = originalResolveFilename;
    esmHooks?.deregister();
  }
}
