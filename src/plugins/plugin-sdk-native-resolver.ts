import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginLoaderAliasMap, type PluginSdkResolutionPreference } from "./sdk-alias.js";

type ResolveFilename = (
  request: string,
  parent: NodeJS.Module | undefined,
  isMain: boolean,
  options?: { paths?: string[] },
) => string;

type ModuleWithResolver = typeof Module & {
  _resolveFilename?: ResolveFilename;
};

export type InstallOpenClawPluginSdkNativeResolverOptions = {
  modulePath?: string;
  pluginModulePath?: string;
  allowedParentRoots?: readonly string[];
  argv1?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
};

const moduleWithResolver = Module as ModuleWithResolver;
const PLUGIN_SDK_PACKAGE_PREFIXES = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"] as const;
const pluginSdkNativeAliases = new Map<string, string>();
const allowedParentRoots = new Set<string>();
let installed = false;
let previousResolveFilename: ResolveFilename | undefined;

function resolveLoaderModulePath(options: InstallOpenClawPluginSdkNativeResolverOptions): string {
  return options.modulePath ?? fileURLToPath(options.moduleUrl ?? import.meta.url);
}

function isPluginSdkAliasSpecifier(specifier: string): boolean {
  return PLUGIN_SDK_PACKAGE_PREFIXES.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
}

function normalizePathForBoundary(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function findNearestPackageRoot(modulePath: string): string {
  let cursor = path.dirname(path.resolve(modulePath));
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(cursor, "package.json"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return path.dirname(path.resolve(modulePath));
}

function addAllowedParentRoot(root: string): void {
  allowedParentRoots.add(normalizePathForBoundary(root));
}

function registerAllowedParentRoots(options: InstallOpenClawPluginSdkNativeResolverOptions): void {
  if (options.pluginModulePath) {
    addAllowedParentRoot(findNearestPackageRoot(options.pluginModulePath));
  }
  for (const root of options.allowedParentRoots ?? []) {
    addAllowedParentRoot(root);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, normalizePathForBoundary(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canResolveForParent(parent: NodeJS.Module | undefined): boolean {
  const parentFilename = parent?.filename;
  if (!parentFilename || allowedParentRoots.size === 0) {
    return false;
  }
  return [...allowedParentRoots].some((root) => isWithinRoot(parentFilename, root));
}

function listPluginSdkNativeAliases(
  options: InstallOpenClawPluginSdkNativeResolverOptions,
): Array<readonly [string, string]> {
  const modulePath = resolveLoaderModulePath(options);
  return Object.entries(
    buildPluginLoaderAliasMap(
      modulePath,
      options.argv1 ?? process.argv[1],
      options.moduleUrl,
      // Native require hooks must point at JavaScript artifacts, even when the
      // plugin loader itself is configured to prefer source imports.
      "dist",
    ),
  )
    .filter(([specifier]) => isPluginSdkAliasSpecifier(specifier))
    .flatMap(([specifier, target]) => {
      if (specifier.endsWith(".js")) {
        return [[specifier, target]] as Array<readonly [string, string]>;
      }
      return [
        [specifier, target],
        [`${specifier}.js`, target],
      ] as Array<readonly [string, string]>;
    });
}

function installResolver(): void {
  if (installed || !moduleWithResolver._resolveFilename) {
    return;
  }
  previousResolveFilename = moduleWithResolver._resolveFilename;
  moduleWithResolver._resolveFilename = ((request, parent, isMain, options) => {
    const aliasTarget = pluginSdkNativeAliases.get(request);
    if (aliasTarget && canResolveForParent(parent)) {
      return aliasTarget;
    }
    return previousResolveFilename?.(request, parent, isMain, options) ?? request;
  }) satisfies ResolveFilename;
  installed = true;
}

export function installOpenClawPluginSdkNativeResolver(
  options: InstallOpenClawPluginSdkNativeResolverOptions = {},
): string[] {
  for (const [specifier, target] of listPluginSdkNativeAliases(options)) {
    pluginSdkNativeAliases.set(specifier, target);
  }
  registerAllowedParentRoots(options);
  installResolver();
  return [...pluginSdkNativeAliases.keys()].toSorted();
}

export function resetOpenClawPluginSdkNativeResolverForTest(): void {
  pluginSdkNativeAliases.clear();
  allowedParentRoots.clear();
  if (installed && previousResolveFilename) {
    moduleWithResolver._resolveFilename = previousResolveFilename;
  }
  previousResolveFilename = undefined;
  installed = false;
}
