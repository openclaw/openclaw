/** Installs native Node resolution aliases so plugins can import the OpenClaw SDK in dev and tests. */
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isPathInside, isPathStrictlyInside } from "../infra/path-guards.js";
import { escapeRegExp } from "../shared/regexp.js";
import {
  isPluginSourceModulePath,
  supportsNativeModuleAliasHooks,
  useNodeModuleHooks,
  type BunPluginRuntime,
  type ResolveFilename,
} from "./native-module-require.js";
import { pluginCacheExistsSync, pluginCacheRealpathSync } from "./plugin-cache-files.js";
import { getPluginSdkHostFacts } from "./plugin-cache-sdk.js";
import { getPluginCache } from "./plugin-cache.js";
import { WORKSPACE_PACKAGE_ALIAS_ENTRIES } from "./sdk-alias-workspace.js";
import {
  preparePluginLoaderAliases,
  isPluginSdkAliasSpecifier,
  listWorkspacePackageExportAliasEntries,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";

type ModuleWithResolver = typeof Module & {
  _resolveFilename?: ResolveFilename;
};

/** Resolver install options for CJS `_resolveFilename` and modern ESM loader hooks. */
type InstallOpenClawPluginSdkNativeResolverOptions = {
  modulePath?: string;
  pluginModulePath?: string;
  allowedParentRoots?: readonly string[];
  argv1?: string;
  moduleUrl?: string;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
};

const moduleWithResolver = Module as ModuleWithResolver;
const nodeResolveFilenameProperty = "_resolveFilename" as const;
const INTERNAL_CORE_PACKAGE_ALIASES = [
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpaths: WORKSPACE_PACKAGE_ALIAS_ENTRIES.filter(
      (entry) => entry.packageDir === "markdown-core",
    ).map((entry) => [entry.subpath, entry.srcFile] as const),
  },
  {
    // Mirrors packages/ai/package.json exports; dist file names do not follow
    // the src layout (dist/diagnostics.mjs <- src/utils/diagnostics.ts), so the
    // generic export-map derivation cannot be used here.
    packageName: "@openclaw/ai",
    packageDir: "ai",
    subpaths: [
      ["", "index.ts"],
      ["providers", "providers.ts"],
      ["transports", "transports.ts"],
      ["diagnostics", path.join("utils", "diagnostics.ts")],
      ["event-stream", path.join("utils", "event-stream.ts")],
      ["types", "types.ts"],
      ["validation", "validation.ts"],
      ["internal/anthropic", path.join("internal", "anthropic.ts")],
      ["internal/google-model-family", path.join("internal", "google-model-family.ts")],
      ["internal/openai", path.join("internal", "openai.ts")],
      [
        "internal/openai-responses-payload-policy",
        path.join("internal", "openai-responses-payload-policy.ts"),
      ],
      ["internal/retry-after", path.join("internal", "retry-after.ts")],
      ["internal/runtime", path.join("internal", "runtime.ts")],
      ["internal/shared", path.join("internal", "shared.ts")],
      ["internal/tool-schema", path.join("internal", "tool-schema.ts")],
    ],
  },
  {
    packageName: "@openclaw/llm-core",
    packageDir: "llm-core",
    subpaths: [
      ["", "index.ts"],
      ["model-contracts/anthropic", path.join("model-contracts", "anthropic.ts")],
      ["diagnostics", path.join("utils", "diagnostics.ts")],
      ["event-stream", path.join("utils", "event-stream.ts")],
      ["types", "types.ts"],
      ["validation", "validation.ts"],
    ],
  },
] as const;
const INTERNAL_CORE_EXPORTED_PACKAGE_DIRS = [
  "media-core",
  "normalization-core",
  "acp-core",
  "worker-runtime",
] as const;
const BUN_NATIVE_ALIAS_FILTER = new RegExp(
  `^(?:${[
    "openclaw/plugin-sdk",
    "@openclaw/plugin-sdk",
    ...INTERNAL_CORE_PACKAGE_ALIASES.map((entry) => entry.packageName),
    ...INTERNAL_CORE_EXPORTED_PACKAGE_DIRS.map((packageDir) => `@openclaw/${packageDir}`),
  ]
    .map(escapeRegExp)
    .join("|")})(?:/|$)`,
  "u",
);
let installed = false;

function resolveLoaderModulePath(options: InstallOpenClawPluginSdkNativeResolverOptions): string {
  return options.modulePath ?? fileURLToPath(options.moduleUrl ?? import.meta.url);
}

function isNativeLoadableSdkTarget(targetPath: string): boolean {
  return (
    [".cjs", ".js", ".mjs"].includes(path.extname(targetPath)) ||
    isPluginSourceModulePath(targetPath)
  );
}

const normalizePathForBoundary = (targetPath: string) =>
  pluginCacheRealpathSync(targetPath) ?? path.resolve(targetPath);

function findBundledPluginRoot(modulePath: string): string | undefined {
  const resolvedModulePath = normalizePathForBoundary(modulePath);
  const packageRoot = normalizePathForBoundary(findPackageRoot(modulePath, "host"));
  for (const relativeRoot of ["extensions", "dist/extensions", "dist-runtime/extensions"]) {
    const bundledRoot = path.join(packageRoot, relativeRoot);
    if (!isPathStrictlyInside(bundledRoot, resolvedModulePath)) {
      continue;
    }
    const relative = path.relative(bundledRoot, resolvedModulePath);
    const [pluginId] = relative.split(path.sep);
    if (pluginId) {
      return path.join(bundledRoot, pluginId);
    }
  }
  return undefined;
}

function isNativeHostPackage(packageRoot: string): boolean {
  const facts = getPluginSdkHostFacts(getPluginCache().sdk, packageRoot);
  if (facts.nativePackage === undefined) {
    try {
      // This native host probe historically follows package.json symlinks.
      // Keep that read contract distinct from checked SDK manifest reads.
      const parsed: unknown = JSON.parse(
        fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
      );
      facts.nativePackage = isRecord(parsed)
        ? {
            ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
            hasOpenClawBin: isRecord(parsed.bin) && typeof parsed.bin.openclaw === "string",
          }
        : null;
    } catch {
      facts.nativePackage = null;
    }
  }
  return facts.nativePackage?.name === "openclaw" || facts.nativePackage?.hasOpenClawBin === true;
}

function findPackageRoot(modulePath: string, kind: "nearest" | "host" = "nearest"): string {
  const normalizedModulePath = path.resolve(modulePath);
  const native = getPluginCache().sdk.native;
  const roots = kind === "host" ? native.loaderPackageRoots : native.nearestPackageRoots;
  const cached = roots.get(normalizedModulePath);
  if (cached) {
    return cached;
  }
  let cursor = path.dirname(normalizedModulePath);
  for (let depth = 0; depth < 12; depth += 1) {
    if (
      pluginCacheExistsSync(path.join(cursor, "package.json")) &&
      (kind === "nearest" || isNativeHostPackage(cursor))
    ) {
      roots.set(normalizedModulePath, cursor);
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  const fallback =
    kind === "host" ? findPackageRoot(modulePath) : path.dirname(normalizedModulePath);
  roots.set(normalizedModulePath, fallback);
  return fallback;
}

function resolveInternalCorePackageHostRoot(modulePath: string): string {
  const normalizedModulePath = path.resolve(modulePath);
  const internalCorePackageHostRoots = getPluginCache().sdk.native.hostRoots;
  const cached = internalCorePackageHostRoots.get(normalizedModulePath);
  if (cached) {
    return cached;
  }
  const packageRoot = normalizePathForBoundary(findPackageRoot(normalizedModulePath, "host"));
  internalCorePackageHostRoots.set(normalizedModulePath, packageRoot);
  return packageRoot;
}

function resolveAllowedParentRoot(modulePath: string): string {
  const roots = getPluginCache().sdk.native.allowedParentRoots;
  const key = path.resolve(modulePath);
  const cached = roots.get(key);
  if (cached) {
    return cached;
  }
  const root = findBundledPluginRoot(modulePath) ?? findPackageRoot(modulePath);
  roots.set(key, root);
  return root;
}

function resolveAllowedParentRoots(
  options: InstallOpenClawPluginSdkNativeResolverOptions,
): string[] {
  const roots = new Set<string>();
  if (options.pluginModulePath) {
    roots.add(normalizePathForBoundary(resolveAllowedParentRoot(options.pluginModulePath)));
  }
  for (const root of options.allowedParentRoots ?? []) {
    roots.add(normalizePathForBoundary(root));
  }
  return [...roots];
}

function resolveAliasTargetForParentUrl(
  request: string,
  parentUrl: string | undefined,
): string | undefined {
  if (
    !parentUrl?.startsWith("file:") ||
    (!isPluginSdkAliasSpecifier(request) && !getPluginCache().sdk.native.aliases.has(request))
  ) {
    return undefined;
  }
  try {
    return resolvePluginNativeAliasForParent(request, fileURLToPath(parentUrl));
  } catch {
    return undefined;
  }
}

export function resolvePluginNativeAliasForParent(
  request: string,
  parentFilename: string | undefined,
): string | undefined {
  const native = getPluginCache().sdk.native;
  const sdkRequest = isPluginSdkAliasSpecifier(request);
  const entries = native.aliases.get(request);
  if (!parentFilename || (!sdkRequest && !entries)) {
    return undefined;
  }
  let parent = native.parents.get(parentFilename);
  if (!parent) {
    const filename = normalizePathForBoundary(parentFilename);
    const roots = new Set(native.sdkProviders.keys());
    for (const candidates of native.aliases.values()) {
      for (const { parentRoot } of candidates) {
        roots.add(parentRoot);
      }
    }
    for (const root of roots) {
      if (!isPathInside(root, filename)) {
        roots.delete(root);
      }
    }
    parent = { roots, targets: new Map() };
    native.parents.set(parentFilename, parent);
  }
  if (parent.targets.has(request)) {
    return parent.targets.get(request);
  }
  let resolvedTarget: string | undefined;
  if (sdkRequest) {
    let first: { target: string; order: number } | undefined;
    for (const [root, provider] of native.sdkProviders) {
      if (!parent.roots.has(root)) {
        continue;
      }
      // Eager registration used the first SDK demand, not installation order,
      // to break ties between overlapping roots. Preserve that order lazily.
      provider.order ??= native.nextSdkProviderOrder++;
      const target = provider.resolveAlias(
        request.endsWith(".js") ? request.slice(0, -3) : request,
      );
      if (target && isNativeLoadableSdkTarget(target) && (!first || provider.order < first.order)) {
        first = { target, order: provider.order };
      }
    }
    resolvedTarget = first ? path.normalize(first.target) : undefined;
  } else {
    resolvedTarget = entries?.find((entry) => parent.roots.has(entry.parentRoot))?.target;
  }
  parent.targets.set(request, resolvedTarget);
  return resolvedTarget;
}

function listInternalCorePackageNativeAliases(packageRoot: string): Array<{
  request: string;
  target: string;
  parentRoots: string[];
}> {
  const parentRoots = ["src", "scripts", "packages", "test"]
    .map((segment) => path.join(packageRoot, segment))
    .filter((candidate) => pluginCacheExistsSync(candidate))
    .map(normalizePathForBoundary);
  if (parentRoots.length === 0) {
    return [];
  }

  const aliases: Array<{
    request: string;
    target: string;
    parentRoots: string[];
  }> = [];
  const internalCorePackageAliases = [
    ...INTERNAL_CORE_PACKAGE_ALIASES,
    ...INTERNAL_CORE_EXPORTED_PACKAGE_DIRS.map((packageDir) => ({
      packageName: `@openclaw/${packageDir}`,
      packageDir,
      subpaths: listWorkspacePackageExportAliasEntries({
        packageRoot,
        packageName: `@openclaw/${packageDir}`,
        packageDir,
      }).map((entry) => [entry.subpath, entry.srcFile] as const),
    })),
  ];
  for (const entry of internalCorePackageAliases) {
    for (const [subpath, srcFile] of entry.subpaths) {
      const request = subpath ? `${entry.packageName}/${subpath}` : entry.packageName;
      const target = path.join(packageRoot, "packages", entry.packageDir, "src", srcFile);
      if (pluginCacheExistsSync(target)) {
        aliases.push({ request, target, parentRoots });
      }
    }
  }
  return aliases;
}

function installResolver(): void {
  const native = getPluginCache().sdk.native;
  if (installed || !(native.aliases.size || native.sdkProviders.size)) {
    return;
  }
  // SAFETY: Bun exposes this synchronous public API; Node leaves the optional global absent.
  const bun = (globalThis as typeof globalThis & { Bun?: BunPluginRuntime }).Bun;
  if (bun) {
    bun.plugin({
      name: "openclaw-plugin-sdk-alias",
      setup(builder) {
        builder.onResolve(
          { filter: BUN_NATIVE_ALIAS_FILTER, namespace: "file" },
          ({ path: request, importer }) => {
            const target = resolvePluginNativeAliasForParent(request, importer);
            return target ? { path: target, namespace: "file" } : undefined;
          },
        );
      },
    });
  }
  const previousResolveFilename = moduleWithResolver[nodeResolveFilenameProperty];
  // Packaged runtimes without aliases must retain the runtime's native resolution path.
  if (!previousResolveFilename || !supportsNativeModuleAliasHooks()) {
    installed = Boolean(bun);
    return;
  }
  moduleWithResolver[nodeResolveFilenameProperty] = ((request, parent, isMain, options) =>
    resolvePluginNativeAliasForParent(request, parent?.filename) ??
    previousResolveFilename(request, parent, isMain, options)) satisfies ResolveFilename;
  if (useNodeModuleHooks()) {
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        const aliasTarget = resolveAliasTargetForParentUrl(specifier, context.parentURL);
        const resolved = aliasTarget
          ? { shortCircuit: true, url: pathToFileURL(aliasTarget).href }
          : nextResolve(specifier, context);
        if (context.conditions.includes("import") && resolved.url.startsWith("file:")) {
          const filename = fileURLToPath(resolved.url);
          const sdkTarget = isPluginSdkAliasSpecifier(specifier)
            ? aliasTarget
            : Array.from(getPluginCache().sdk.contexts.values()).some(({ sdkRoots }) =>
                  sdkRoots.includes(path.dirname(filename)),
                )
              ? resolveAliasTargetForParentUrl(
                  `openclaw/plugin-sdk/${path.basename(filename, path.extname(filename))}`,
                  context.parentURL,
                )
              : undefined;
          // Built plugins use relative SDK URLs. Match the authorized host alias before
          // evaluation so later synchronous loads never inherit an uninstantiated job.
          if (sdkTarget && pathToFileURL(sdkTarget).href === resolved.url) {
            Module.createRequire(import.meta.url)(sdkTarget);
          }
        }
        return resolved;
      },
    });
  }
  installed = true;
}

function registerNativeAlias(params: {
  request: string;
  target: string;
  parentRoots: readonly string[];
}): void {
  const pluginSdkNativeAliases = getPluginCache().sdk.native.aliases;
  getPluginCache().sdk.native.parents.clear();
  const entries = pluginSdkNativeAliases.get(params.request) ?? [];
  for (const parentRoot of params.parentRoots) {
    const existingIndex = entries.findIndex((entry) => entry.parentRoot === parentRoot);
    if (existingIndex !== -1) {
      entries[existingIndex] = { parentRoot, target: params.target };
      continue;
    }
    entries.push({ parentRoot, target: params.target });
  }
  if (entries.length > 0) {
    pluginSdkNativeAliases.set(params.request, entries);
  }
}

function clearNativeAliasesForParentRoots(parentRoots: readonly string[]): void {
  if (parentRoots.length === 0) {
    return;
  }
  const parentRootSet = new Set(parentRoots);
  getPluginCache().sdk.native.parents.clear();
  for (const root of parentRoots) {
    getPluginCache().sdk.native.sdkProviders.delete(root);
  }
  const pluginSdkNativeAliases = getPluginCache().sdk.native.aliases;
  for (const [request, entries] of pluginSdkNativeAliases) {
    const nextEntries = entries.filter((entry) => !parentRootSet.has(entry.parentRoot));
    if (nextEntries.length === 0) {
      pluginSdkNativeAliases.delete(request);
    } else {
      pluginSdkNativeAliases.set(request, nextEntries);
    }
  }
}

function registerInternalCorePackageNativeAliases(
  options: InstallOpenClawPluginSdkNativeResolverOptions,
): void {
  const packageRoot = resolveInternalCorePackageHostRoot(resolveLoaderModulePath(options));
  const registeredInternalCorePackageHosts = getPluginCache().sdk.native.registeredHosts;
  if (registeredInternalCorePackageHosts.has(packageRoot)) {
    return;
  }
  for (const alias of listInternalCorePackageNativeAliases(packageRoot)) {
    registerNativeAlias(alias);
  }
  registeredInternalCorePackageHosts.add(packageRoot);
}

export function installOpenClawPluginSdkNativeResolver(
  options: InstallOpenClawPluginSdkNativeResolverOptions = {},
): void {
  const parentRoots = resolveAllowedParentRoots(options);
  clearNativeAliasesForParentRoots(parentRoots);
  const aliases = preparePluginLoaderAliases({
    modulePath: options.pluginModulePath ?? resolveLoaderModulePath(options),
    argv1: options.argv1 ?? process.argv[1],
    moduleUrl: options.moduleUrl ?? pathToFileURL(resolveLoaderModulePath(options)).href,
    pluginSdkResolution: options.pluginSdkResolution,
    devSourceRoot: options.devSourceRoot,
  });
  const native = getPluginCache().sdk.native;
  for (const parentRoot of parentRoots) {
    native.sdkProviders.set(parentRoot, { resolveAlias: aliases.resolveAlias });
  }
  registerInternalCorePackageNativeAliases(options);
  installResolver();
}

export function installOpenClawInternalCorePackageNativeResolver(
  options: Pick<InstallOpenClawPluginSdkNativeResolverOptions, "moduleUrl"> = {},
): string[] {
  registerInternalCorePackageNativeAliases(options);
  installResolver();
  return [...getPluginCache().sdk.native.aliases.keys()].toSorted();
}
