import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginRegistryParams } from "../plugins/registry-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { listCoreGatewayMethodNames } from "./methods/core-descriptors.js";
import { mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config.js";
import { listGatewayMethods } from "./server-methods-list.js";

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
  /** Config snapshot captured at Gateway start. */
  cfgAtStart: OpenClawConfig;
  /** Runtime config after recovery/default hydration. */
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

/** Builds plugin startup state and gateway method lists before the server binds. */
export async function prepareGatewayPluginBootstrap(params: {
  /** Config snapshot captured at Gateway start. */
  cfgAtStart: OpenClawConfig;
  /** Source config used for plugin activation policy before runtime defaults. */
  activationSourceConfig?: OpenClawConfig;
  /** Runtime config after recovery/default hydration. */
  startupRuntimeConfig: OpenClawConfig;
  /** Optional plugin metadata snapshot from config loading. */
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Minimal test gateways skip most plugin runtime loading. */
  minimalTestGateway: boolean;
  /** Bootstrap logger used by plugin/channel startup maintenance. */
  log: GatewayPluginBootstrapLog;
  /** Whether to load full runtime plugins during pre-bind bootstrap. */
  loadRuntimePlugins?: boolean;
  /** Whether to load setup-runtime hooks for deferred channel plugins only. */
  loadSetupRuntimePlugins?: boolean;
}) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;
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
      const { runStartupSessionMigration } = await import("./server-startup-session-migration.js");
      startupTasks.push(
        runStartupSessionMigration({
          cfg: params.cfgAtStart,
          env: process.env,
          log: params.log,
        }),
      );
    }
    await Promise.all(startupTasks);
  }

  initSubagentRegistry();

  // Activation uses the pre-runtime source so auto-enable policy cannot be skewed by
  // defaults injected while loading runtime config; runtime-only plugin config still merges in.
  const gatewayPluginConfig = params.minimalTestGateway
    ? params.cfgAtStart
    : mergeActivationSectionsIntoRuntimeConfig({
        runtimeConfig: params.cfgAtStart,
        activationConfig: applyPluginAutoEnable({
          config: activationSourceConfig,
          env: process.env,
          ...(params.pluginMetadataSnapshot?.manifestRegistry
            ? { manifestRegistry: params.pluginMetadataSnapshot.manifestRegistry }
            : {}),
          discovery: params.pluginMetadataSnapshot?.discovery,
        }).config,
      });
  const pluginsGloballyDisabled = gatewayPluginConfig.plugins?.enabled === false;
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfig);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfig, defaultAgentId);
  const pluginLookUpTable =
    params.minimalTestGateway || pluginsGloballyDisabled
      ? undefined
      : loadPluginLookUpTable({
          config: gatewayPluginConfig,
          workspaceDir: defaultWorkspaceDir,
          env: process.env,
          activationSourceConfig,
          metadataSnapshot: params.pluginMetadataSnapshot,
        });
  const deferredConfiguredChannelPluginIds = [
    ...(pluginLookUpTable?.startup.configuredDeferredChannelPluginIds ?? []),
  ];
  const startupPluginIds = [...(pluginLookUpTable?.startup.pluginIds ?? [])];

  const baseMethods = listGatewayMethods();
  const coreGatewayMethodNames = listCoreGatewayMethodNames();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  let pluginRegistry;
  let baseGatewayMethods = baseMethods;
  const shouldLoadRuntimePlugins = params.loadRuntimePlugins !== false;
  const shouldLoadSetupRuntimePlugins =
    params.loadSetupRuntimePlugins === true && deferredConfiguredChannelPluginIds.length > 0;

  if (!params.minimalTestGateway && shouldLoadSetupRuntimePlugins) {
    // Pre-bind bootstrap only loads deferred channel plugins that expose setup runtime hooks.
    // Full plugin handlers are loaded later so startup does not register duplicate methods.
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = await loadGatewayStartupPluginRuntime(
      {
        cfg: gatewayPluginConfig,
        activationSourceConfig,
        workspaceDir: defaultWorkspaceDir,
        log: params.log,
        baseMethods,
        coreGatewayMethodNames,
        startupPluginIds: deferredConfiguredChannelPluginIds,
        pluginLookUpTable,
        preferSetupRuntimeForChannelPlugins: true,
        suppressPluginInfoLogs: true,
      },
    ));
  } else if (!params.minimalTestGateway && shouldLoadRuntimePlugins) {
    // Normal bootstrap loads every startup plugin and records that runtime handlers are ready
    // before the gateway exposes the method list.
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = await loadGatewayStartupPluginRuntime(
      {
        cfg: gatewayPluginConfig,
        activationSourceConfig,
        workspaceDir: defaultWorkspaceDir,
        log: params.log,
        baseMethods,
        coreGatewayMethodNames,
        startupPluginIds,
        pluginLookUpTable,
        preferSetupRuntimeForChannelPlugins: false,
        suppressPluginInfoLogs: false,
      },
    ));
  } else {
    // Minimal gateway tests reuse an already-active registry when present; production no-load
    // paths install a fresh empty registry so stale plugin handlers cannot leak across starts.
    pluginRegistry = params.minimalTestGateway
      ? (getActivePluginRegistry() ?? emptyPluginRegistry)
      : emptyPluginRegistry;
    setActivePluginRegistry(pluginRegistry);
  }

  return {
    gatewayPluginConfigAtStart: gatewayPluginConfig,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    pluginLookUpTable,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods,
    runtimePluginsLoaded:
      !params.minimalTestGateway && shouldLoadRuntimePlugins && !shouldLoadSetupRuntimePlugins,
  };
}

/** Loads startup plugin runtimes through the deferred bootstrap boundary. */
export async function loadGatewayStartupPluginRuntime(params: {
  /** Runtime plugin config to pass into plugin loading. */
  cfg: OpenClawConfig;
  /** Source config used for activation policy, when different from runtime config. */
  activationSourceConfig?: OpenClawConfig;
  /** Default workspace directory for plugin host services. */
  workspaceDir: string;
  /** Plugin bootstrap logger. */
  log: GatewayPluginBootstrapLog;
  /** Gateway methods available before plugin methods are added. */
  baseMethods: string[];
  /** Core Gateway method names used to protect core descriptors. */
  coreGatewayMethodNames?: readonly string[];
  /** Optional host services injected into plugin loading. */
  hostServices?: PluginRegistryParams["hostServices"];
  /** Plugin ids selected for startup loading. */
  startupPluginIds: string[];
  /** Optional lookup table prepared before runtime loading. */
  pluginLookUpTable?: ReturnType<typeof loadPluginLookUpTable>;
  /** Prefer setup-runtime entrypoints for channel plugins during setup bootstrap. */
  preferSetupRuntimeForChannelPlugins?: boolean;
  /** Suppress plugin info logs during setup-runtime-only bootstrap. */
  suppressPluginInfoLogs?: boolean;
  /** Optional startup trace collector. */
  startupTrace?: GatewayStartupTrace;
}) {
  // Keep server-plugin-bootstrap behind one lazy boundary; startup config tests can exercise
  // planning without importing plugin package runtimes.
  const { loadGatewayStartupPlugins } = await import("./server-plugin-bootstrap.js");
  return loadGatewayStartupPlugins({
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
    preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    suppressPluginInfoLogs: params.suppressPluginInfoLogs,
    startupTrace: params.startupTrace,
  });
}
