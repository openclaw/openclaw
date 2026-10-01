// Gateway plugin bootstrap helpers.
// Resolves activation config before loading or staging a Gateway registry.
import { performance } from "node:perf_hooks";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { PluginLogger } from "../plugins/logger-types.js";
import {
  getPluginCache,
  getPluginMetadataSnapshotCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  findActiveDegradedPlugin,
  formatPluginVerificationDiagnostic,
} from "../plugins/runtime-degraded-state.js";
import { resolveDurableWorkerProviderAutoEnabledReasons } from "../plugins/worker-provider-manifest.js";
import { mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config.js";
import { loadGatewayPlugins } from "./server-plugins.js";

type GatewayPluginBootstrapLog = Required<PluginLogger>;
type GatewayPluginBootstrapParams = Omit<
  Parameters<typeof loadGatewayPlugins>[0],
  "autoEnabledReasons"
> & { log: GatewayPluginBootstrapLog; logDiagnostics?: boolean };

// Reload replaces the cache's metadata object and permits the next generation's notices.
const loggedInfoByMetadata = new WeakMap<object, Set<string>>();

// Keep plugin/source attribution without exposing internal diagnostic objects.
function logGatewayPluginDiagnostics(params: {
  diagnostics: PluginRegistry["diagnostics"];
  log: Pick<GatewayPluginBootstrapLog, "error" | "warn" | "info">;
}) {
  const metadata = getPluginCache().metadata;
  const loggedInfo = loggedInfoByMetadata.get(metadata) ?? new Set<string>();
  loggedInfoByMetadata.set(metadata, loggedInfo);
  for (const diag of params.diagnostics) {
    if (diag.level === "info") {
      const key = JSON.stringify([diag.pluginId, diag.message]);
      if (loggedInfo.has(key)) {
        continue;
      }
      loggedInfo.add(key);
    }
    const degradedPlugin = diag.pluginId ? findActiveDegradedPlugin(diag.pluginId) : undefined;
    // Startup preflight already emitted this typed owner diagnostic. Keep it
    // in the registry for health/status, but do not print it a second time.
    if (
      diag.code === "plugin-verification" &&
      degradedPlugin &&
      diag.message === formatPluginVerificationDiagnostic(degradedPlugin.diagnostic)
    ) {
      continue;
    }
    const details = [
      diag.pluginId ? `plugin=${diag.pluginId}` : null,
      diag.source ? `source=${diag.source}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(", ");
    const message = details
      ? `[plugins] ${diag.message} (${details})`
      : `[plugins] ${diag.message}`;
    params.log[diag.level](message);
  }
}

/** The caller joins accepted cleanup even when synchronous publication throws. */
export type GatewayPluginRuntimePreparation = (
  loaded: ReturnType<typeof prepareGatewayPluginLoad>,
  trackActivationCleanup: (completion: Promise<void>) => void,
) => Promise<{
  publish: () => void;
  afterCommit: () => void;
}>;

/** Prepares gateway plugin runtime and returns the loaded plugin registry state. */
export function prepareGatewayPluginLoad(params: GatewayPluginBootstrapParams) {
  return withPluginCache(
    params.pluginMetadataSnapshot
      ? getPluginMetadataSnapshotCache(params.pluginMetadataSnapshot)
      : getPluginCache(),
    () => {
      const started = performance.now();
      const { log, logDiagnostics = true, ...loadParams } = params;
      const activationSourceConfig = params.activationSourceConfig ?? params.cfg;
      const autoEnabled = applyPluginAutoEnable({
        config: activationSourceConfig,
        env: params.env ?? process.env,
        ...(params.pluginLookUpTable?.manifestRegistry
          ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry }
          : {}),
        discovery: params.pluginLookUpTable?.discovery,
        ambientEnvTriggers: params.ambientEnvTriggers,
      });
      const autoEnableMs = performance.now() - started;
      const resolvedConfig =
        activationSourceConfig === params.cfg
          ? autoEnabled.config
          : mergeActivationSectionsIntoRuntimeConfig({
              runtimeConfig: params.cfg,
              activationConfig: autoEnabled.config,
            });
      const durableReasons = params.pluginLookUpTable
        ? resolveDurableWorkerProviderAutoEnabledReasons(
            params.pluginLookUpTable.manifestRegistry,
            params.pluginLookUpTable.workerProviderIds,
          )
        : {};
      const autoEnabledReasons = { ...autoEnabled.autoEnabledReasons, ...durableReasons };
      params.startupTrace?.detail("plugins.gateway-prepare", [
        ["autoEnableMs", autoEnableMs],
        ["resolvedConfigMs", performance.now() - started - autoEnableMs],
      ]);
      const loaded = loadGatewayPlugins({
        ...loadParams,
        cfg: resolvedConfig,
        activationSourceConfig,
        autoEnabledReasons,
        channelPluginLoadIntent: params.channelPluginLoadIntent ?? "full",
      });
      if (logDiagnostics && loaded.pluginRegistry.diagnostics.length > 0) {
        logGatewayPluginDiagnostics({
          diagnostics: loaded.pluginRegistry.diagnostics,
          log,
        });
      }
      return { ...loaded, resolvedConfig };
    },
  );
}
