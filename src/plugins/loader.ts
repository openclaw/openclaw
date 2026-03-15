import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_EXTENSION_HOST_REGISTRY_CACHE_ENTRIES } from "../extension-host/activation/loader-cache.js";
import {
  clearExtensionHostLoaderState,
  loadExtensionHostPluginRegistry,
} from "../extension-host/activation/loader-orchestrator.js";
import {
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
} from "../extension-host/compat/loader-compat.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { PluginRegistry } from "./registry.js";

export type PluginLoadResult = PluginRegistry;

export type PluginLoadOptions =
  import("../extension-host/activation/loader-orchestrator.js").ExtensionHostPluginLoadOptions;

export function clearPluginLoaderCache(): void {
  clearExtensionHostLoaderState();
}

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  return loadExtensionHostPluginRegistry(options);
}

function resolveExtensionApiAlias(params: { modulePath?: string } = {}): string | null {
  try {
    const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
    const packageRoot = resolveOpenClawPackageRootSync({
      cwd: path.dirname(modulePath),
    });
    if (!packageRoot) {
      return null;
    }

    const orderedKinds = resolvePluginSdkAliasCandidateOrder({
      modulePath,
      isProduction: process.env.NODE_ENV === "production",
    });
    const candidateMap = {
      src: path.join(packageRoot, "src", "extensionAPI.ts"),
      dist: path.join(packageRoot, "dist", "extensionAPI.js"),
    } as const;
    for (const kind of orderedKinds) {
      const candidate = candidateMap[kind];
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export const __testing = {
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  resolveExtensionApiAlias,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
  maxPluginRegistryCacheEntries: MAX_EXTENSION_HOST_REGISTRY_CACHE_ENTRIES,
};
