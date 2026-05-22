import Module from "node:module";
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
  argv1?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
};

const moduleWithResolver = Module as ModuleWithResolver;
const PLUGIN_SDK_PACKAGE_PREFIXES = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"] as const;
const pluginSdkNativeAliases = new Map<string, string>();
let installed = false;
let previousResolveFilename: ResolveFilename | undefined;

function resolveLoaderModulePath(options: InstallOpenClawPluginSdkNativeResolverOptions): string {
  if (options.modulePath) {
    return options.modulePath;
  }
  return fileURLToPath(options.moduleUrl ?? import.meta.url);
}

function isPluginSdkAliasSpecifier(specifier: string): boolean {
  return PLUGIN_SDK_PACKAGE_PREFIXES.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
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
  if (installed || !moduleWithResolver["_resolveFilename"]) {
    return;
  }
  previousResolveFilename = moduleWithResolver["_resolveFilename"];
  moduleWithResolver["_resolveFilename"] = ((request, parent, isMain, options) => {
    const aliasTarget = pluginSdkNativeAliases.get(request);
    if (aliasTarget) {
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
  installResolver();
  return [...pluginSdkNativeAliases.keys()].toSorted();
}

export function resetOpenClawPluginSdkNativeResolverForTest(): void {
  pluginSdkNativeAliases.clear();
  if (installed && previousResolveFilename) {
    moduleWithResolver["_resolveFilename"] = previousResolveFilename;
  }
  previousResolveFilename = undefined;
  installed = false;
}
