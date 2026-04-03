import { primeConfiguredBindingRegistry } from "../channels/plugins/binding-registry.js";
import type { loadConfig } from "../config/config.js";
import { resolvePluginActivationSnapshot } from "../plugins/activation-context.js";
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
  activationSourceConfig?: ReturnType<typeof loadConfig>;
  workspaceDir: string;
  log: GatewayPluginBootstrapLog;
  coreGatewayHandlers: Record<string, GatewayRequestHandler>;
  baseMethods: string[];
  pluginIds?: string[];
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

export function prepareGatewayPluginLoad(params: GatewayPluginBootstrapParams) {
  const activation = resolvePluginActivationSnapshot({
    rawConfig: params.activationSourceConfig ?? params.cfg,
    env: process.env,
    applyAutoEnable: true,
  });
  const resolvedConfig = activation.config ?? params.cfg;
  installGatewayPluginRuntimeEnvironment(resolvedConfig);
  const loaded = loadGatewayPlugins({
    cfg: resolvedConfig,
    activationSourceConfig: params.activationSourceConfig ?? params.cfg,
    autoEnabledReasons: activation.autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    log: params.log,
    coreGatewayHandlers: params.coreGatewayHandlers,
    baseMethods: params.baseMethods,
    pluginIds: params.pluginIds,
    preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
  });
  params.beforePrimeRegistry?.(loaded.pluginRegistry);
  primeConfiguredBindingRegistry({ cfg: resolvedConfig });
  if ((params.logDiagnostics ?? true) && loaded.pluginRegistry.diagnostics.length > 0) {
    logGatewayPluginDiagnostics({
      diagnostics: loaded.pluginRegistry.diagnostics,
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
