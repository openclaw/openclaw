import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import { getCurrentPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot.runtime.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  PREPARED_THINKING_POLICY,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
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
  entries: PreparedGatewayModelCatalog["entries"];
  routeVariants?: PreparedGatewayModelCatalog["routeVariants"];
}) {
  const { metadataSnapshot: metadata, pluginRegistry } = params;
  const { entries: pluginEntries, ...pluginPolicy } = params.config?.plugins ?? {};
  const index = new Map(metadata.index.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const codePolicy = (pluginId: string, value: object) => {
    const owner = getPluginValueInstance(value);
    // Managed wrappers change on reload; their captured code and plugin config own policy.
    return owner &&
      (owner.sourceDigest !== undefined || metadata.byPluginId.get(pluginId)?.origin === "bundled")
      ? { sourceDigest: owner.sourceDigest }
      : { unmanaged: value };
  };
  // Prepared thinking callbacks have the same code/config lifetime as their registrations.
  const catalogFacts = (
    entries:
      | readonly (PreparedGatewayModelCatalog["entries"][number] & ThinkingCatalogPolicyCarrier)[]
      | undefined,
  ) =>
    entries?.map((entry) => {
      const { [PREPARED_THINKING_POLICY]: thinking, ...data } = entry;
      return {
        data,
        thinking:
          thinking &&
          codePolicy(getPluginValueInstance(thinking.resolve)?.pluginId ?? "", thinking.resolve),
      };
    });
  const registeredOwners = new Set(
    [
      ...pluginRegistry.providers,
      ...pluginRegistry.agentHarnesses,
      ...pluginRegistry.cliBackends,
      ...pluginRegistry.sessionExtensions,
    ].map((registration) => registration.pluginId),
  );
  return {
    entries: catalogFacts(params.entries),
    routeVariants: catalogFacts(params.routeVariants),
    providers: pluginRegistry.providers.map(({ pluginId, source, rootDir, provider }) => ({
      pluginId,
      source,
      rootDir,
      code: codePolicy(pluginId, provider),
      id: provider.id,
      // Managed array wrappers compare by generation even when their elements match.
      aliases: provider.aliases ? [...provider.aliases] : undefined,
      hookAliases: provider.hookAliases ? [...provider.hookAliases] : undefined,
      thinking: Boolean(provider.resolveThinkingProfile),
      normalization: Boolean(provider.normalizeModelId),
      fastMode: Boolean(provider.resolveFastModeSupport),
      serviceTiers: Boolean(provider.resolveServiceTiers),
    })),
    agentHarnesses: pluginRegistry.agentHarnesses.map(({ pluginId, source, rootDir, harness }) => ({
      pluginId,
      source,
      rootDir,
      code: codePolicy(pluginId, harness),
      id: harness.id,
      autoSelection: harness.autoSelection
        ? { providerIds: [...harness.autoSelection.providerIds] }
        : undefined,
      cloudPlacement: harness.cloudPlacement && {
        mode: harness.cloudPlacement.mode,
        devicePlacement: harness.cloudPlacement.devicePlacement && {
          requiredNodeCommands: [...harness.cloudPlacement.devicePlacement.requiredNodeCommands],
          consumesWorkerSlot: harness.cloudPlacement.devicePlacement.consumesWorkerSlot,
        },
      },
      workspaceEnvironment: harness.workspaceEnvironment && { ...harness.workspaceEnvironment },
      supports: typeof harness.supports === "function",
      ownership: typeof harness.resolveSessionRuntimeOwnership === "function",
      asyncOwnership: typeof harness.resolveSessionRuntimeOwnershipAsync === "function",
    })),
    cliBackends: pluginRegistry.cliBackends.map(({ pluginId, source, rootDir, backend }) => ({
      pluginId,
      source,
      rootDir,
      code: codePolicy(pluginId, backend),
      id: backend.id,
      modelProvider: backend.modelProvider,
    })),
    sessionExtensions: pluginRegistry.sessionExtensions.map(
      ({ pluginId, source, rootDir, extension }) => ({
        pluginId,
        source,
        rootDir,
        code: codePolicy(pluginId, extension),
        namespace: extension.namespace,
        project: Boolean(extension.project),
      }),
    ),
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
      .map((plugin) => {
        const installed = index.get(plugin.id);
        return {
          plugin,
          installed: installed && {
            pluginId: installed.pluginId,
            origin: installed.origin,
            enabled: installed.enabled,
            enabledByDefault: installed.enabledByDefault,
            enabledByDefaultOnPlatforms: installed.enabledByDefaultOnPlatforms,
            contributions: installed.contributions,
            source: installed.source,
            rootDir: installed.rootDir,
            manifestHash: installed.manifestHash,
            packageHash: installed.packageJson?.hash,
            packageVersion: installed.packageVersion,
            installRecordHash: installed.installRecordHash,
          },
          config: pluginEntries?.[plugin.id],
        };
      }),
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
