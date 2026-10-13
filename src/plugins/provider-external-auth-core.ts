/** Resolves external auth overlays through metadata and synchronous provider hooks. */
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type {
  ProviderExternalAuthProfile,
  ProviderExternalAuthProfileResolver,
  ProviderExternalAuthProfileResolverPreparation,
} from "./provider-external-auth.types.js";
import type { createProviderHookRuntime } from "./provider-hook-runtime-core.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";

export function createProviderExternalAuthResolver(
  hooks: Pick<
    ReturnType<typeof createProviderHookRuntime>,
    "resolveProviderPluginsForHooks" | "resolveProviderPluginsForHooksAsync"
  >,
) {
  const { resolveProviderPluginsForHooks, resolveProviderPluginsForHooksAsync } = hooks;

  function resolveExternalAuthProfilesWithPlugins(
    params: Parameters<ProviderExternalAuthProfileResolver>[0],
  ): ReturnType<ProviderExternalAuthProfileResolver> {
    const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
    const env = params.env ?? process.env;
    const config = params.config ?? {};
    const currentMetadataSnapshot =
      params.pluginMetadataSnapshot ??
      getCurrentPluginMetadataSnapshot({
        env,
        ...(params.config ? { config } : { requireDefaultDiscoveryContext: true }),
        ...(workspaceDir ? { workspaceDir } : { allowWorkspaceScopedSnapshot: true }),
      });
    if (!currentMetadataSnapshot) {
      throw new Error(
        "External auth metadata is not prepared; await provider runtime preparation before reading profiles.",
      );
    }
    const { manifestRegistry } = currentMetadataSnapshot;
    // A lifecycle-owned manifest is authoritative: no external-auth contracts means
    // no provider registry discovery or runtime activation is needed for this overlay.
    const externalAuthPluginIds = manifestRegistry.plugins
      .filter((plugin) => (plugin.contracts?.externalAuthProviders?.length ?? 0) > 0)
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));
    if (externalAuthPluginIds.length === 0) {
      return [];
    }
    const matches: ProviderExternalAuthProfile[] = [];
    for (const plugin of resolveProviderPluginsForHooks({
      ...params,
      workspaceDir,
      env,
      onlyPluginIds: externalAuthPluginIds,
      pluginMetadataSnapshot: currentMetadataSnapshot,
    })) {
      matches.push(...(plugin.resolveExternalAuthProfiles?.(params.context) ?? []));
    }
    return matches;
  }

  async function prepareExternalAuthProfilesWithPlugins(
    params: Parameters<ProviderExternalAuthProfileResolverPreparation>[0],
  ): ReturnType<ProviderExternalAuthProfileResolverPreparation> {
    const snapshot = params.pluginMetadataSnapshot;
    const workspaceDir = params.workspaceDir ?? snapshot.workspaceDir;
    const env = params.env ?? process.env;
    const onlyPluginIds = snapshot.manifestRegistry.plugins
      .filter((plugin) => (plugin.contracts?.externalAuthProviders?.length ?? 0) > 0)
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));
    if (onlyPluginIds.length === 0) {
      return () => [];
    }
    const plugins = await resolveProviderPluginsForHooksAsync({
      ...params,
      workspaceDir,
      env,
      onlyPluginIds,
      pluginMetadataSnapshot: snapshot,
    });
    return (context) =>
      plugins.flatMap((plugin) => plugin.resolveExternalAuthProfiles?.(context) ?? []);
  }

  return { resolveExternalAuthProfilesWithPlugins, prepareExternalAuthProfilesWithPlugins };
}
