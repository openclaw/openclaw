import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

export const BUNDLED_WEB_SEARCH_PLUGIN_IDS = [
  "brave",
  "firecrawl",
  "google",
  "moonshot",
  "perplexity",
  "xai",
] as const;

const bundledWebSearchPluginIdSet = new Set<string>(BUNDLED_WEB_SEARCH_PLUGIN_IDS);

export function resolveBundledWebSearchPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return registry.plugins
    .filter((plugin) => plugin.origin === "bundled" && bundledWebSearchPluginIdSet.has(plugin.id))
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}
