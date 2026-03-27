import { primeConfiguredBindingRegistry } from "../channels/plugins/binding-registry.js";
import type { loadConfig } from "../config/config.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { pinActivePluginChannelRegistry } from "../plugins/runtime.js";
import { setGatewaySubagentRuntime } from "../plugins/runtime/index.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import {
  createGatewaySubagentRuntime,
  loadGatewayPlugins,
  setPluginSubagentOverridePolicies,
} from "./server-plugins.js";

type GatewayPluginBootstrapLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

type GatewayPluginBootstrapParams = {
  cfg: ReturnType<typeof loadConfig>;
  workspaceDir: string;
  log: GatewayPluginBootstrapLog;
  coreGatewayHandlers: Record<string, GatewayRequestHandler>;
  baseMethods: string[];
  preferSetupRuntimeForChannelPlugins?: boolean;
  logDiagnostics?: boolean;
  beforePrimeRegistry?: (pluginRegistry: PluginRegistry) => void;
};

function installGatewayPluginRuntimeEnvironment(cfg: ReturnType<typeof loadConfig>) {
  setPluginSubagentOverridePolicies(cfg);
  setGatewaySubagentRuntime(createGatewaySubagentRuntime());
}

function logGatewayPluginDiagnostics(params: {
  diagnostics: PluginRegistry["diagnostics"];
  log: Pick<GatewayPluginBootstrapLog, "error" | "info">;
}) {
  for (const diag of params.diagnostics) {
    const details = [
      diag.pluginId ? `plugin=${diag.pluginId}` : null,
      diag.source ? `source=${diag.source}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(", ");
    const message = details
      ? `[plugins] ${diag.message} (${details})`
      : `[plugins] ${diag.message}`;
    if (diag.level === "error") {
      params.log.error(message);
    } else {
      params.log.info(message);
    }
  }
}

/**
 * Emit per-plugin load status and a consolidated startup summary.
 *
 * Addresses https://github.com/openclaw/openclaw/issues/55803 — plugin
 * load/health status was previously invisible in logs unless an error occurred.
 * This function logs every plugin's outcome (loaded, disabled, error) so
 * operators can quickly verify which plugins are active after startup or
 * a config reload.
 */
function logPluginLoadSummary(params: {
  plugins: PluginRegistry["plugins"];
  log: Pick<GatewayPluginBootstrapLog, "info" | "warn">;
}) {
  let loaded = 0;
  let disabled = 0;
  let errored = 0;

  for (const plugin of params.plugins) {
    const toolCount = plugin.toolNames.length;
    const hookCount = plugin.hookCount;
    const channelCount = plugin.channelIds.length;

    // Build a compact capability summary for loaded plugins.
    const capabilities: string[] = [];
    if (toolCount > 0) {
      capabilities.push(`${toolCount} tools`);
    }
    if (hookCount > 0) {
      capabilities.push(`${hookCount} hooks`);
    }
    if (channelCount > 0) {
      capabilities.push(`${channelCount} channels`);
    }
    if (plugin.providerIds.length > 0) {
      capabilities.push(`${plugin.providerIds.length} providers`);
    }

    const capSuffix = capabilities.length > 0 ? ` (${capabilities.join(", ")})` : "";

    if (plugin.status === "loaded") {
      loaded++;
      params.log.info(`[plugins] load: ${plugin.id} status=loaded enabled=true${capSuffix}`);
    } else if (plugin.status === "disabled") {
      disabled++;
      params.log.info(`[plugins] load: ${plugin.id} status=disabled enabled=false`);
    } else {
      errored++;
      params.log.warn(
        `[plugins] load: ${plugin.id} status=error error=${plugin.error ?? "unknown"}`,
      );
    }
  }

  // Consolidated summary line for quick health assessment.
  params.log.info(
    `[plugins] summary: ${params.plugins.length} total, ${loaded} loaded, ${disabled} disabled, ${errored} errored`,
  );
}

export function prepareGatewayPluginLoad(params: GatewayPluginBootstrapParams) {
  installGatewayPluginRuntimeEnvironment(params.cfg);
  const loaded = loadGatewayPlugins({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    log: params.log,
    coreGatewayHandlers: params.coreGatewayHandlers,
    baseMethods: params.baseMethods,
    preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
  });
  params.beforePrimeRegistry?.(loaded.pluginRegistry);
  primeConfiguredBindingRegistry({ cfg: params.cfg });
  if ((params.logDiagnostics ?? true) && loaded.pluginRegistry.diagnostics.length > 0) {
    logGatewayPluginDiagnostics({
      diagnostics: loaded.pluginRegistry.diagnostics,
      log: params.log,
    });
  }
  // Per-plugin load status and consolidated summary (see #55803).
  if (loaded.pluginRegistry.plugins.length > 0) {
    logPluginLoadSummary({
      plugins: loaded.pluginRegistry.plugins,
      log: params.log,
    });
  }
  return loaded;
}

export function loadGatewayStartupPlugins(
  params: Omit<GatewayPluginBootstrapParams, "beforePrimeRegistry">,
) {
  return prepareGatewayPluginLoad(params);
}

export function reloadDeferredGatewayPlugins(
  params: Omit<
    GatewayPluginBootstrapParams,
    "beforePrimeRegistry" | "preferSetupRuntimeForChannelPlugins"
  >,
) {
  return prepareGatewayPluginLoad({
    ...params,
    beforePrimeRegistry: pinActivePluginChannelRegistry,
  });
}
