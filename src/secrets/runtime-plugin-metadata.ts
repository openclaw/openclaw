/** Supplies one plugin metadata view to secrets assignment and provider preflight. */
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadRuntimeManifestHelpers = createLazyRuntimeModule(
  () => import("./runtime-manifest.runtime.js"),
);

export async function resolveSecretsPluginMetadata(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins"> & {
    manifestRegistry: Pick<PluginManifestRegistry, "plugins">;
  };
}): Promise<{
  loadablePluginOrigins: ReadonlyMap<string, PluginOrigin>;
  manifestRegistry: Pick<PluginManifestRegistry, "plugins">;
}> {
  const workspaceDir = resolveAgentWorkspaceDir(
    params.config,
    resolveDefaultAgentId(params.config),
    params.env,
  );
  const { listPluginOriginsFromMetadataSnapshot, loadPluginMetadataSnapshot } =
    await loadRuntimeManifestHelpers();
  const snapshot =
    params.pluginMetadataSnapshot ??
    loadPluginMetadataSnapshot({
      config: params.config,
      workspaceDir,
      env: params.env,
    });
  return {
    loadablePluginOrigins: listPluginOriginsFromMetadataSnapshot(snapshot),
    manifestRegistry: snapshot.manifestRegistry,
  };
}

function hasConfiguredPluginEntries(config: OpenClawConfig): boolean {
  const entries = config.plugins?.entries;
  return (
    Boolean(entries) &&
    typeof entries === "object" &&
    !Array.isArray(entries) &&
    Object.keys(entries).length > 0
  );
}

function hasConfiguredChannelEntries(config: OpenClawConfig): boolean {
  const channels = config.channels;
  return (
    Boolean(channels) &&
    typeof channels === "object" &&
    !Array.isArray(channels) &&
    Object.keys(channels).some((channelId) => channelId !== "defaults")
  );
}

export function hasConfiguredPluginIntegrationSecretProviders(config: OpenClawConfig): boolean {
  const providers = config.secrets?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return false;
  }
  return Object.values(providers).some(
    (provider) =>
      provider?.source === "exec" &&
      "pluginIntegration" in provider &&
      provider.pluginIntegration !== undefined,
  );
}

export function shouldLoadPluginMetadataForSecrets(config: OpenClawConfig): boolean {
  return (
    hasConfiguredPluginEntries(config) ||
    hasConfiguredChannelEntries(config) ||
    hasConfiguredPluginIntegrationSecretProviders(config)
  );
}
