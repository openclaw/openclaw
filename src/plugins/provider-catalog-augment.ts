/** Supplemental model catalog rows from provider plugins' augment hooks. */
import { runProviderIsolated } from "../agents/provider-failure-isolation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { resolveProviderPluginsForHooks } from "./provider-hook-runtime.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import { resolveCatalogHookProviderPluginIds } from "./providers.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import type { ProviderAugmentModelCatalogContext, ProviderPlugin } from "./types.js";

type CatalogHookParams = {
  providerIds?: readonly string[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
};

function resolveProviderPluginsForCatalogHooks(params: CatalogHookParams): ProviderPlugin[] {
  const workspaceDir =
    params.workspaceDir ??
    params.metadataSnapshot?.workspaceDir ??
    getActivePluginRegistryWorkspaceDirFromState();
  const env = params.env ?? process.env;
  const onlyPluginIds = resolveCatalogHookProviderPluginIds({
    config: params.config,
    workspaceDir,
    env,
    metadataSnapshot: params.metadataSnapshot,
  });
  if (onlyPluginIds.length === 0 || params.providerIds?.length === 0) {
    return [];
  }
  const providers = resolveProviderPluginsForHooks({
    ...params,
    workspaceDir,
    env,
    onlyPluginIds,
    providerRefs: params.providerIds,
    pluginMetadataSnapshot: params.metadataSnapshot,
  });
  const providerIds = params.providerIds;
  return providerIds
    ? providers.filter((provider) =>
        providerIds.some((providerRef) => matchesProviderPluginRef(provider, providerRef)),
      )
    : providers;
}

export async function augmentModelCatalogWithProviderPlugins(
  params: CatalogHookParams & { context: ProviderAugmentModelCatalogContext },
) {
  const supplemental: ProviderAugmentModelCatalogContext["entries"] = [];
  for (const plugin of resolveProviderPluginsForCatalogHooks(params)) {
    const entries = await runProviderIsolated(
      { providerIds: [plugin.id], stage: "catalog augment" },
      async () => await plugin.augmentModelCatalog?.(params.context),
    );
    supplemental.push(...(entries ?? []));
  }
  return supplemental;
}
