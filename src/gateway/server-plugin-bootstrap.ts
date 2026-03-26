import { primeConfiguredBindingRegistry } from "../channels/plugins/binding-registry.js";
import type { loadConfig } from "../config/config.js";
import { loadGuardrailProvider } from "../guardrails/index.js";
import { configureGuardrails } from "../agents/pi-tools.before-tool-call.js";
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

async function installGuardrailsFromConfig(
  cfg: ReturnType<typeof loadConfig>,
  log: GatewayPluginBootstrapLog,
) {
  const gc = cfg.guardrails;
  if (!gc?.enabled || !gc.provider?.use) {
    return;
  }
  try {
    const provider = await loadGuardrailProvider(gc.provider);
    configureGuardrails(provider, gc.failClosed !== false);
    if (provider.healthCheck) {
      const health = await provider.healthCheck();
      if (!health.ok) {
        log.warn(`[guardrails] provider health check failed: ${health.message}`);
      }
    }
    log.info(`[guardrails] provider '${provider.name}' loaded (failClosed=${gc.failClosed !== false})`);
  } catch (err) {
    log.error(`[guardrails] failed to load provider: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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

export async function prepareGatewayPluginLoad(params: GatewayPluginBootstrapParams) {
  installGatewayPluginRuntimeEnvironment(params.cfg);
  await installGuardrailsFromConfig(params.cfg, params.log);
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
  return loaded;
}

export async function loadGatewayStartupPlugins(
  params: Omit<GatewayPluginBootstrapParams, "beforePrimeRegistry">,
) {
  return prepareGatewayPluginLoad(params);
}

export async function reloadDeferredGatewayPlugins(
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
