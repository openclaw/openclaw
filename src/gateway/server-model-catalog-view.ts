import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot.runtime.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { PreparedGatewayModelCatalog } from "./server-model-catalog.types.js";

// Captured facts follow their view's lifetime without widening the public Gateway context.
const factsByCatalog = new WeakMap<
  PreparedGatewayModelCatalog,
  { metadata: PluginMetadataSnapshot; rowPolicy?: ReturnType<typeof captureSessionRowPolicy> }
>();

type SessionRowPolicyRegistry = Pick<
  PluginRegistry,
  "providers" | "agentHarnesses" | "cliBackends" | "sessionExtensions"
>;

function captureSessionRowPolicy(params: {
  config?: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry: SessionRowPolicyRegistry;
}) {
  const { metadataSnapshot: metadata, pluginRegistry } = params;
  const { entries, ...pluginPolicy } = params.config?.plugins ?? {};
  const index = new Map(metadata.index.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const registeredOwners = new Set(
    [
      ...pluginRegistry.providers,
      ...pluginRegistry.agentHarnesses,
      ...pluginRegistry.cliBackends,
      ...pluginRegistry.sessionExtensions,
    ].map((registration) => registration.pluginId),
  );
  return {
    providers: pluginRegistry.providers,
    agentHarnesses: pluginRegistry.agentHarnesses,
    cliBackends: pluginRegistry.cliBackends,
    sessionExtensions: pluginRegistry.sessionExtensions,
    providerOwners: metadata.owners.providers,
    normalization: metadata.owners.modelIdNormalizationPolicies,
    pluginPolicy,
    manifests: metadata.plugins
      .filter(
        (plugin) =>
          registeredOwners.has(plugin.id) ||
          plugin.providers.length > 0 ||
          plugin.cliBackends.length > 0 ||
          plugin.setup?.providers?.length ||
          plugin.setup?.cliBackends?.length ||
          plugin.activation?.onAgentHarnesses?.length ||
          plugin.modelCatalog?.providers ||
          plugin.modelIdNormalization,
      )
      .map((plugin) => ({
        plugin,
        installed: index.get(plugin.id),
        config: entries?.[plugin.id],
      })),
  };
}

export function createPreparedGatewayModelCatalog(
  params: Omit<PreparedGatewayModelCatalog, "pluginRegistry"> & {
    pluginRegistry?: SessionRowPolicyRegistry;
    metadataSnapshot?: PluginMetadataSnapshot;
    config?: OpenClawConfig;
  },
): PreparedGatewayModelCatalog {
  const catalog: PreparedGatewayModelCatalog = {
    entries: params.entries,
    routeVariants: params.routeVariants,
    pluginRegistry: params.pluginRegistry,
  };
  if (params.metadataSnapshot) {
    // Row dependencies retain their selected generation's manifests and config policy.
    factsByCatalog.set(catalog, {
      metadata: params.metadataSnapshot,
      rowPolicy: params.pluginRegistry
        ? captureSessionRowPolicy({
            ...params,
            metadataSnapshot: params.metadataSnapshot,
            pluginRegistry: params.pluginRegistry,
          })
        : undefined,
    });
  }
  return catalog;
}

export function readPreparedGatewaySessionRowPolicy(catalog: PreparedGatewayModelCatalog) {
  return factsByCatalog.get(catalog)?.rowPolicy;
}

export function readPreparedGatewayModelCatalogMetadata(
  catalog: PreparedGatewayModelCatalog | undefined,
): PluginMetadataSnapshot | undefined {
  return catalog ? factsByCatalog.get(catalog)?.metadata : undefined;
}

/** A prepared miss stays authoritative instead of starting discovery during presentation. */
export function readPreparedGatewayModelMetadata(
  cfg: OpenClawConfig,
  catalog?: PreparedGatewayModelCatalog,
): PluginMetadataSnapshot | null {
  if (catalog) {
    return readPreparedGatewayModelCatalogMetadata(catalog) ?? null;
  }
  return (
    getCurrentPluginMetadataSnapshotRuntime({
      config: cfg,
      allowSynchronousPolicyRead: false,
      allowScopedSnapshot: true,
      allowWorkspaceScopedSnapshot: true,
    }) ?? null
  );
}
