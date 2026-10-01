import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPathInside } from "../infra/path-guards.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PLUGIN_SOURCE_CAPTURE_PREFIX } from "./plugin-source-capture-path.js";

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
};

let nativeAliasHookSupport: boolean | undefined;

/** Older Bun loses createRequire's parent when its private resolver is wrapped. */
export function supportsNativeModuleAliasHooks(): boolean {
  if (!process.versions.bun) {
    return true;
  }
  if (nativeAliasHookSupport !== undefined) {
    return nativeAliasHookSupport;
  }
  const previous = moduleWithResolver["_resolveFilename"];
  if (!previous) {
    return (nativeAliasHookSupport = false);
  }
  let retainsParent = false;
  moduleWithResolver["_resolveFilename"] = (request, parent) => {
    retainsParent = typeof parent?.filename === "string";
    return request;
  };
  try {
    createRequire(import.meta.url).resolve(fileURLToPath(import.meta.url));
  } finally {
    moduleWithResolver["_resolveFilename"] = previous;
  }
  return (nativeAliasHookSupport = retainsParent);
}

type CapturedModuleBinding = {
  resolve: (request: string, parent: string, resolve: () => string) => string | undefined;
  prepare: (request: string, parent: string, kind?: BunPluginImportKind) => string | undefined;
  load?: (request: string) => { contents: string; loader: "js" } | undefined;
};
type BunPluginImportKind =
  | "import-statement"
  | "require-call"
  | "require-resolve"
  | "dynamic-import"
  | "import-rule"
  | "url-token"
  | "internal"
  | "entry-point-run"
  | "entry-point-build";
export type BunPluginRuntime = {
  resolveSync?: (specifier: string, parent: string) => string;
  Transpiler: new (options: {
    loader: "jsx" | "tsx";
    tsconfig: {
      compilerOptions: {
        jsx: "react";
        jsxFactory: string;
        jsxFragmentFactory: string;
      };
    };
  }) => { transformSync(source: string): string };
  plugin(options: {
    name: string;
    setup(builder: {
      onResolve(
        options: { filter: RegExp; namespace: "file" },
        callback: (args: {
          path: string;
          importer: string;
          kind?: BunPluginImportKind;
        }) => { path: string; namespace: "file" } | undefined,
      ): void;
      onLoad(
        options: { filter: RegExp; namespace: "file" },
        callback: (args: { path: string }) => { contents: string; loader: "js" | "jsx" | "tsx" },
      ): void;
    }): void;
  }): void;
};

const bunRuntimeOnResolveProbe = resolveGlobalSingleton(
  Symbol.for("openclaw.bunRuntimeOnResolveProbe"),
  () => ({ tested: false, supported: false }),
);

/** Whether Bun can redirect runtime-computed specifiers through public onResolve hooks. */
export function supportsBunRuntimeOnResolveTargets(): boolean {
  if (bunRuntimeOnResolveProbe.tested) {
    return bunRuntimeOnResolveProbe.supported;
  }
  bunRuntimeOnResolveProbe.tested = true;
  const bun = (globalThis as typeof globalThis & { Bun?: BunPluginRuntime }).Bun;
  if (!bun?.resolveSync) {
    return false;
  }
  const specifier = "openclaw-bun-runtime-onresolve-probe";
  const target = fileURLToPath(import.meta.url);
  let seen = false;
  try {
    bun.plugin({
      name: specifier,
      setup(builder) {
        builder.onResolve(
          { filter: /^openclaw-bun-runtime-onresolve-probe$/u, namespace: "file" },
          () => {
            seen = true;
            return { path: target, namespace: "file" };
          },
        );
      },
    });
    bunRuntimeOnResolveProbe.supported =
      bun.resolveSync(specifier, path.dirname(target)) === target && seen;
  } catch {
    bunRuntimeOnResolveProbe.supported = false;
  }
  return bunRuntimeOnResolveProbe.supported;
}

const capturedModuleResolvers = resolveGlobalSingleton(
  Symbol.for("openclaw.capturedModuleResolvers"),
  () => ({
    installed: false,
    loaderInstalled: false,
    resolving: false,
    owners: new Set<CapturedModuleBinding>(),
  }),
);

function resolveCapturedPluginModule<T>(
  resolve: (owner: CapturedModuleBinding) => T | undefined,
): T | undefined {
  if (capturedModuleResolvers.resolving) {
    return undefined;
  }
  capturedModuleResolvers.resolving = true;
  try {
    for (const owner of capturedModuleResolvers.owners) {
      const target = resolve(owner);
      if (target) {
        return target;
      }
    }
  } finally {
    capturedModuleResolvers.resolving = false;
  }
  return undefined;
}

function installCapturedPluginModuleResolver(bun: BunPluginRuntime | undefined): void {
  if (bun) {
    bun.plugin({
      name: "openclaw-plugin-source-capture",
      setup(builder) {
        builder.onResolve(
          { filter: /.*/, namespace: "file" },
          ({ path: request, importer, kind }) => {
            const target = resolveCapturedPluginModule((owner) =>
              owner.prepare(request, importer, kind),
            );
            // Package selection stays native; owners redirect only captured physical source paths.
            return target ? { path: target, namespace: "file" } : undefined;
          },
        );
      },
    });
    return;
  }

  const previous = moduleWithResolver["_resolveFilename"]!;
  moduleWithResolver["_resolveFilename"] = (request, parent, isMain, options) => {
    const filename = parent?.filename;
    const target = filename
      ? resolveCapturedPluginModule((owner) =>
          owner.resolve(request, filename, () => previous(request, parent, isMain, options)),
        )
      : undefined;
    return target ?? previous(request, parent, isMain, options);
  };
}

function installCapturedPluginModuleLoader(bun: BunPluginRuntime): void {
  bun.plugin({
    name: "openclaw-plugin-source-jsx",
    setup(builder) {
      builder.onLoad(
        {
          filter: new RegExp(
            `${PLUGIN_SOURCE_CAPTURE_PREFIX}[^/\\\\]+[/\\\\].*\\.[cm]?[jt]sx$`,
            "u",
          ),
          namespace: "file",
        },
        ({ path: modulePath }) =>
          resolveCapturedPluginModule((owner) => owner.load?.(modulePath)) ?? {
            contents: fs.readFileSync(modulePath, "utf8"),
            loader: modulePath.toLowerCase().endsWith(".jsx") ? "jsx" : "tsx",
          },
      );
    },
  });
}

/** Captured parents retain their resolver while their instance's consumers drain. */
export function registerCapturedPluginModuleResolver(binding: CapturedModuleBinding): () => void {
  // SAFETY: Bun supplies this synchronous public API; Node leaves the optional global absent.
  const bun = (globalThis as typeof globalThis & { Bun?: BunPluginRuntime }).Bun;
  if (!capturedModuleResolvers.installed) {
    installCapturedPluginModuleResolver(bun);
    // Older Bun drops createRequire's ESM parent when this private hook is replaced.
    // Its public resolver above retains the importer without changing native resolution.
    capturedModuleResolvers.installed = true;
  }
  if (binding.load && bun && !capturedModuleResolvers.loaderInstalled) {
    installCapturedPluginModuleLoader(bun);
    capturedModuleResolvers.loaderInstalled = true;
  }
  capturedModuleResolvers.owners.add(binding);
  return () => {
    capturedModuleResolvers.owners.delete(binding);
  };
}

/** True for file extensions Node can load through the native JS module loader. */
export function isJavaScriptModulePath(modulePath: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(path.extname(modulePath).toLowerCase());
}

export function resolvePluginLoaderTryNative(
  modulePath: string,
  options?: {
    preferBuiltDist?: boolean;
  },
): boolean {
  const nativeExtension = [".js", ".mjs", ".cjs", ".json"].includes(
    path.extname(modulePath).trim().toLowerCase(),
  );
  if (modulePath.replace(/\\/g, "/").includes("/dist/extensions/")) {
    return nativeExtension;
  }
  return (
    nativeExtension ||
    (options?.preferBuiltDist === true && modulePath.includes(`${path.sep}dist${path.sep}`))
  );
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
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return (
    code === "ERR_REQUIRE_ESM" ||
    code === "ERR_REQUIRE_ASYNC_MODULE" ||
    code === "ERR_REQUIRE_ESM_RACE_CONDITION" ||
    code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" ||
    code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING" ||
    code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    isMissingTargetModuleError(error, modulePath)
  );
}

/** Attempts native require before falling back to source transform paths. */
export function tryNativeRequireJavaScriptModule(
  moduleSpecifier: string,
  options: Parameters<typeof tryNativeRequireModule>[1] = {},
): { ok: true; moduleExport: unknown } | { ok: false } {
  const modulePath = toNativeRequirePath(moduleSpecifier);
  const bunNativeSource = Boolean(process.versions.bun) && isPluginSourceModulePath(modulePath);
  if (!isJavaScriptModulePath(modulePath) && !bunNativeSource) {
    return { ok: false };
  }
  return tryNativeRequireModule(moduleSpecifier, options);
}

/** Loads prepared host aliases, including source SDK paths supported by the runtime. */
export function tryNativeRequireModule(
  moduleSpecifier: string,
  options: {
    aliasMap?:
      | Record<string, string>
      | ((specifier: string, parent?: string) => string | undefined);
    fallbackOnMissingDependency?: boolean;
  } = {},
): { ok: true; moduleExport: unknown } | { ok: false } {
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
  let resolvedPath: string;
  try {
    resolvedPath = withNativeRequireAliases(options.aliasMap, () => require.resolve(modulePath));
  } catch (error) {
    const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    if (
      isSourceTransformFallbackError(error, modulePath) ||
      (options.fallbackOnMissingDependency === true &&
        (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND"))
    ) {
      return { ok: false };
    }
    throw error;
  }
  try {
    // Requiring the resolved target could apply a second alias to the same request.
    const moduleExport = withNativeRequireAliases(options.aliasMap, () => require(modulePath));
    nativeModuleLoadFailures.delete(resolvedPath);
    return { ok: true, moduleExport };
  } catch (error) {
    const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    if (
      nativeModuleLoadFailures.has(resolvedPath) &&
      (code === "ERR_REQUIRE_ESM_RACE_CONDITION" || code === "ERR_INTERNAL_ASSERTION")
    ) {
      throw nativeModuleLoadFailures.get(resolvedPath);
    }
    if (isSourceTransformFallbackError(error, modulePath)) {
      return { ok: false };
    }
    nativeModuleLoadFailures.set(resolvedPath, error);
    throw error;
  }
}

/** Explicit public-library invalidation refreshes the current path synchronously. */
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
  aliasMap:
    | Record<string, string>
    | ((specifier: string, parent?: string) => string | undefined)
    | undefined,
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
      const parent = context.parentURL?.startsWith("file:")
        ? fileURLToPath(context.parentURL)
        : undefined;
      const aliasTarget = resolveAlias(specifier, parent);
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
    const aliasTarget = resolveAlias(request, parent?.filename);
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
