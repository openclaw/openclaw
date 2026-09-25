import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagents/registry/subagent-registry.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { validateConfiguredBindings } from "../channels/plugins/configured-binding-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectConfiguredMemoryEmbeddingStartupProviderOwners,
  collectRegisteredEmbeddingProviderIds,
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
  listAmbientOnlyConfiguredChannelIds,
} from "../plugins/channel-plugin-ids.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getRegisteredEmbeddingProvider } from "../plugins/embedding-providers.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import {
  completePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { resolveProviderPolicySurfaceForOwner } from "../plugins/provider-public-artifacts.js";
import {
  markPluginRegistryActive,
  withPluginRegistryPreparationScope,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry, PluginRegistryParams } from "../plugins/registry-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { disposePluginRegistryInstances, getActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";
import { listGatewayMethods } from "./server-methods-list.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

type GatewayStartupTrace = {
  detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
};

/** Returns the config snapshot used by channel/plugin startup maintenance. */
export function resolveGatewayStartupMaintenanceConfig(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
}): OpenClawConfig {
  // Early config recovery may supply channel blocks after the start snapshot; startup
  // maintenance needs those owner configs even when the original snapshot was sparse.
  return params.cfgAtStart.channels === undefined &&
    params.startupRuntimeConfig.channels !== undefined
    ? {
        ...params.cfgAtStart,
        channels: params.startupRuntimeConfig.channels,
      }
    : params.cfgAtStart;
}

/** Runs channel, session, and pairing maintenance before plugin bootstrap. */
export async function runGatewayStartupMaintenance(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
}): Promise<void> {
  const startupMaintenanceConfig = resolveGatewayStartupMaintenanceConfig({
    cfgAtStart: params.cfgAtStart,
    startupRuntimeConfig: params.startupRuntimeConfig,
  });

  const shouldRunStartupMaintenance =
    !params.minimalTestGateway || startupMaintenanceConfig.channels !== undefined;
  if (shouldRunStartupMaintenance) {
    const { runChannelPluginStartupMaintenance } =
      await import("../channels/plugins/lifecycle-startup.js");
    const startupTasks = [
      runChannelPluginStartupMaintenance({
        cfg: startupMaintenanceConfig,
        env: process.env,
        log: params.log,
      }),
    ];
    if (!params.minimalTestGateway) {
      const { migrateLegacyDesktopStreamOptOuts } =
        await import("../infra/device-pairing-node-desktop-migration.js");
      const retiredDesktopApprovals =
        await migrateLegacyDesktopStreamOptOuts(startupMaintenanceConfig);
      if (retiredDesktopApprovals > 0) {
        params.log.warn(
          `Preserved disabled desktop access for ${retiredDesktopApprovals} paired node(s); approve their updated desktop capability to enable sharing.`,
        );
      }
      const { runStartupSessionMigration } = await import("./server-startup-session-migration.js");
      startupTasks.push(
        runStartupSessionMigration({
          cfg: params.cfgAtStart,
          env: process.env,
          log: params.log,
        }),
      );
      const { listLegacyPairingStoreFiles } = await import("../infra/pairing-files.js");
      startupTasks.push(
        listLegacyPairingStoreFiles().then(
          (files) => {
            if (files.length > 0) {
              params.log.warn(
                `Legacy pairing stores require repair: ${files.join(", ")}. Stop the Gateway and run openclaw doctor --fix.`,
              );
            }
          },
          (error: unknown) => {
            params.log.warn(
              `Legacy pairing store inspection failed: ${String(error)}. Stop the Gateway and run openclaw doctor --fix.`,
            );
          },
        ),
      );
    }
    await Promise.all(startupTasks);
  }
}

/** Builds plugin startup state and gateway method lists before the server binds. */
export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;
  initSubagentRegistry();

  // Activation uses the pre-runtime source so auto-enable policy cannot be skewed by
  // defaults injected while loading runtime config; runtime-only plugin config still merges in.
  const gatewayPluginConfig = params.minimalTestGateway
    ? params.cfgAtStart
    : resolveGatewayStartupPluginActivationConfig({
        runtimeConfig: params.cfgAtStart,
        activationSourceConfig,
        env: process.env,
        ...(params.pluginMetadataSnapshot?.manifestRegistry
          ? { manifestRegistry: params.pluginMetadataSnapshot.manifestRegistry }
          : {}),
        discovery: params.pluginMetadataSnapshot?.discovery,
        ambientEnvTriggers: params.ambientEnvTriggers,
      });
  const pluginsGloballyDisabled = gatewayPluginConfig.plugins?.enabled === false;
  const pluginWorkspaceDir = tryResolveConfiguredAgentWorkspaceDir(gatewayPluginConfig);
  const defaultWorkspaceDir = pluginWorkspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const pluginLookUpTable =
    params.minimalTestGateway || pluginsGloballyDisabled
      ? undefined
      : loadPluginLookUpTable({
          config: gatewayPluginConfig,
          workspaceDir: pluginWorkspaceDir,
          env: process.env,
          activationSourceConfig,
          metadataSnapshot: params.pluginMetadataSnapshot,
          workerProviderIds: params.workerProviderIds ?? [],
          ambientEnvTriggers: params.ambientEnvTriggers,
        });
  // Startup logging and lifecycle publication consume the process-stable metadata snapshot.
  // Minimal gateways skip runtime lookup-table construction, not metadata ownership.
  const pluginManifestRecords =
    pluginLookUpTable?.manifestRegistry.plugins ??
    params.pluginMetadataSnapshot?.manifestRegistry.plugins ??
    [];
  const startupPluginIds = [...(pluginLookUpTable?.startup.pluginIds ?? [])];
  const ambientAutostartSuppressedChannelIds =
    params.ambientEnvTriggers === "suppress"
      ? new Set(
          listAmbientOnlyConfiguredChannelIds({
            config: params.cfgAtStart,
            activationSourceConfig,
            env: process.env,
            includePersistedAuthState: false,
            manifestRecords: pluginManifestRecords,
          }),
        )
      : new Set<string>();

  const baseMethods = listGatewayMethods();
  // Core requests need a live local registry without displacing another Gateway's plugins.
  const emptyPluginRegistry = createEmptyPluginRegistry();
  markPluginRegistryActive(emptyPluginRegistry);
  const pluginRegistry =
    params.minimalTestGateway && !pluginsGloballyDisabled
      ? (getActivePluginRegistry() ?? emptyPluginRegistry)
      : emptyPluginRegistry;
  const metadataSnapshot =
    getGatewayPluginMetadataSnapshot() ??
    completePluginMetadataSnapshot({
      snapshot: pluginLookUpTable ?? params.pluginMetadataSnapshot,
      config: activationSourceConfig,
      env: process.env,
      workspaceDir: defaultWorkspaceDir,
    });
  // Requests can reach this registry before runtime attachment (or without it).
  // Carry the complete boot generation so cold capabilities never rediscover source plugins.
  setPluginRuntimeLoadContext(pluginRegistry, {
    rawConfig: params.cfgAtStart,
    config: gatewayPluginConfig,
    activationSourceConfig,
    autoEnabledReasons: {},
    workspaceDir: pluginWorkspaceDir,
    env: process.env,
    logger: params.log,
    metadataSnapshot,
    manifestRegistry: metadataSnapshot?.manifestRegistry,
    installRecords: metadataSnapshot
      ? extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index)
      : undefined,
    preferBuiltPluginArtifacts: true,
  });

  return {
    gatewayPluginConfigAtStart: gatewayPluginConfig,
    defaultWorkspaceDir,
    pluginWorkspaceDir,
    startupPluginIds,
    pluginManifestRecords,
    pluginMetadataSnapshot: metadataSnapshot,
    pluginLookUpTable,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods: baseMethods,
    ambientAutostartSuppressedChannelIds,
  };
}

/**
 * Warn when `memory.search.provider` selects a memory embedding provider
 * that no loaded plugin registered. Without the owning plugin, `active-memory`
 * cannot embed and silently falls back to keyword/FTS-only recall.
 */
export function warnUnregisteredConfiguredMemoryEmbeddingProviders(params: {
  config: OpenClawConfig;
  pluginRegistry: Partial<Pick<PluginRegistry, "embeddingProviders">>;
  log: Pick<GatewayPluginBootstrapLog, "warn">;
}): void {
  const unregistered = collectUnregisteredConfiguredMemoryEmbeddingProviders({
    config: params.config,
    registeredProviderIds: collectRegisteredEmbeddingProviderIds(params.pluginRegistry),
  });
  for (const provider of unregistered) {
    const path = `memory.search.${provider.source}`;
    params.log.warn(
      `${path}="${provider.configuredId}" is configured, but no loaded plugin registered a memory embedding provider that can serve "${provider.configuredId}". Semantic memory recall will fall back to keyword/FTS-only search. Ensure the plugin that provides "${provider.configuredId}" is installed and enabled.`,
    );
  }
}

async function warnConfiguredMemoryEmbeddingProviderSetup(params: {
  config: OpenClawConfig;
  pluginRegistry: PluginRegistry;
  pluginLookUpTable?: ReturnType<typeof loadPluginLookUpTable>;
  log: Pick<GatewayPluginBootstrapLog, "warn">;
}): Promise<void> {
  const manifestRegistry = getPluginRuntimeLoadContext(params.pluginRegistry)?.manifestRegistry ??
    params.pluginLookUpTable?.manifestRegistry ?? { plugins: [] };
  await Promise.all(
    collectConfiguredMemoryEmbeddingStartupProviderOwners(params.config).flatMap((provider) => {
      const registered = [...provider.ownerIds]
        .map((ownerId) => getRegisteredEmbeddingProvider(ownerId))
        .find((entry) => entry !== undefined);
      const owner = manifestRegistry.plugins.find(
        (plugin) => plugin.id === registered?.ownerPluginId,
      );
      if (provider.agentIds.size === 0 || !owner) {
        return [];
      }
      let policy: ReturnType<typeof resolveProviderPolicySurfaceForOwner>;
      try {
        policy = resolveProviderPolicySurfaceForOwner(owner);
      } catch (error) {
        params.log.warn(
          `Memory embedding provider "${provider.configuredId}" setup could not be checked (${String(error)}). Run "openclaw doctor" to retry.`,
        );
        return [];
      }
      const inspectSetup = policy?.inspectEmbeddingProviderSetup;
      if (!inspectSetup) {
        return [];
      }
      return [...provider.agentIds].map(async (agentId) => {
        try {
          const setup = await inspectSetup({
            config: params.config,
            env: process.env,
            agentId,
            provider: provider.configuredId,
          });
          if (setup) {
            params.log.warn(
              `Agent "${agentId}": semantic memory recall is degraded (${provider.source}="${provider.configuredId}"). ${setup.reason}${setup.fixHint ? ` ${setup.fixHint}` : ""}`,
            );
          }
        } catch (error) {
          params.log.warn(
            `Agent "${agentId}": memory embedding setup could not be checked (${String(error)}). Run "openclaw doctor" to retry.`,
          );
        }
      });
    }),
  );
}

/** Loads startup plugin runtimes after the gateway listener binds. */
export async function loadGatewayStartupPluginRuntime(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  log: GatewayPluginBootstrapLog;
  baseMethods: string[];
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  startupPluginIds: string[];
  pluginLookUpTable?: ReturnType<typeof loadPluginLookUpTable>;
  startupTrace?: GatewayStartupTrace;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  resolveGatewayContext?: GatewayContextResolver;
  pluginRuntimeClaim?: GatewayPluginRuntimeClaim;
  getCurrentPluginRegistry?: () => PluginRegistry;
}) {
  // Keep server-plugin-bootstrap behind one lazy boundary; startup config tests can exercise
  // planning without importing plugin package runtimes.
  const { prepareGatewayPluginLoad } = await import("./server-plugin-bootstrap.js");
  await params.pluginRuntimeClaim?.waitForUnblocked();
  if (params.pluginRuntimeClaim && !params.pluginRuntimeClaim.isCurrent()) {
    const currentPluginRegistry = params.getCurrentPluginRegistry?.();
    if (!currentPluginRegistry) {
      throw new Error("superseded Gateway startup cannot resolve the current plugin runtime");
    }
    return {
      pluginRegistry: currentPluginRegistry,
      gatewayMethods: params.baseMethods,
    };
  }
  const loaded = prepareGatewayPluginLoad({
    loadIntent: "startup",
    cfg: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
    workspaceDir: params.workspaceDir,
    log: params.log,
    coreGatewayMethodNames: params.coreGatewayMethodNames ?? params.baseMethods,
    baseMethods: params.baseMethods,
    ...(params.hostServices !== undefined && {
      hostServices: params.hostServices,
    }),
    pluginIds: params.startupPluginIds,
    pluginLookUpTable: params.pluginLookUpTable,
    channelPluginLoadIntent: "full",
    startupTrace: params.startupTrace,
    ambientEnvTriggers: params.ambientEnvTriggers,
    ...(params.resolveGatewayContext
      ? { resolveGatewayContext: params.resolveGatewayContext }
      : {}),
  });
  try {
    withPluginRegistryPreparationScope(loaded.pluginRegistry, () =>
      withPluginRuntimeRegistryScope(loaded.pluginRegistry, () =>
        validateConfiguredBindings(loaded.resolvedConfig),
      ),
    );
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: loaded.resolvedConfig,
      pluginRegistry: loaded.pluginRegistry,
      log: params.log,
    });
    // Setup diagnostics may be asynchronous; a stalled provider must not hold startup.
    void withPluginRuntimeRegistryScope(loaded.pluginRegistry, () =>
      warnConfiguredMemoryEmbeddingProviderSetup({
        config: loaded.resolvedConfig,
        pluginRegistry: loaded.pluginRegistry,
        pluginLookUpTable: params.pluginLookUpTable,
        log: params.log,
      }),
    ).catch((error: unknown) => {
      params.log.warn(`Memory embedding setup checks failed: ${String(error)}`);
    });
    return loaded;
  } catch (error) {
    loaded.retireGatewayRuntimeBindings();
    await disposePluginRegistryInstances(loaded.pluginRegistry).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], "Startup plugin candidate cleanup failed", {
        cause: error,
      });
    });
    throw error;
  }
}
