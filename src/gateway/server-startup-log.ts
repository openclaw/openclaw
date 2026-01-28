import chalk from "chalk";
import { listAgentIds, resolveAgentModelPrimary } from "../agents/agent-scope.js";
import { resolveDefaultSdkProvider } from "../agents/claude-agent-sdk/sdk-runner.config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveMainAgentRuntimeKind } from "../agents/main-agent-runtime-factory.js";
import { resolveConfiguredModelRef, parseModelRef } from "../agents/model-selection.js";
import type { loadConfig } from "../config/config.js";
import { getResolvedLoggerSettings } from "../logging.js";

export function logGatewayStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
}) {
  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const modelRef = `${agentProvider}/${agentModel}`;
  params.log.info(`agent model: ${modelRef}`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}`,
  });

  // Log main-agent runtime configuration
  logMainAgentRuntime(params.cfg, params.log);

  // Log per-agent model/provider definitions
  logAgentDefinitions(params.cfg, params.log);
  const scheme = params.tlsEnabled ? "wss" : "ws";
  const formatHost = (host: string) => (host.includes(":") ? `[${host}]` : host);
  const hosts =
    params.bindHosts && params.bindHosts.length > 0 ? params.bindHosts : [params.bindHost];
  const primaryHost = hosts[0] ?? params.bindHost;
  params.log.info(
    `listening on ${scheme}://${formatHost(primaryHost)}:${params.port} (PID ${process.pid})`,
  );
  for (const host of hosts.slice(1)) {
    params.log.info(`listening on ${scheme}://${formatHost(host)}:${params.port}`);
  }
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }
}

/**
 * Log the main-agent runtime configuration (pi or ccsdk).
 */
function logMainAgentRuntime(
  cfg: ReturnType<typeof loadConfig>,
  log: { info: (msg: string, meta?: Record<string, unknown>) => void },
): void {
  const runtimeKind = resolveMainAgentRuntimeKind(cfg);
  const runtimeLabel = runtimeKind === "ccsdk" ? "ccsdk (Claude Code SDK)" : "pi (embedded)";

  if (runtimeKind === "ccsdk") {
    const mainProvider = resolveDefaultSdkProvider({ config: cfg, agentId: "main" });
    const providerName = mainProvider?.config.name ?? mainProvider?.key ?? "default";
    const sdkModel = cfg?.agents?.main?.sdk?.model;
    const modelLabel = sdkModel ? ` model=${sdkModel}` : "";
    log.info(`main-agent runtime: ${runtimeLabel} provider=${providerName}${modelLabel}`, {
      consoleMessage: `main-agent runtime: ${chalk.cyan(runtimeLabel)} provider=${chalk.whiteBright(providerName)}${modelLabel ? ` model=${chalk.whiteBright(sdkModel)}` : ""}`,
    });
  } else {
    log.info(`main-agent runtime: ${runtimeLabel}`, {
      consoleMessage: `main-agent runtime: ${chalk.cyan(runtimeLabel)}`,
    });
  }

  // Log worker runtime if different from main or if workers also use CCSDK.
  const workerRuntime = cfg?.agents?.defaults?.runtime;
  if (workerRuntime === "ccsdk") {
    const workerProvider = resolveDefaultSdkProvider({ config: cfg, agentId: "worker" });
    const workerProviderName = workerProvider?.config.name ?? workerProvider?.key ?? "default";
    log.info(`worker-agent runtime: ccsdk (Claude Code SDK) provider=${workerProviderName}`, {
      consoleMessage: `worker-agent runtime: ${chalk.cyan("ccsdk (Claude Code SDK)")} provider=${chalk.whiteBright(workerProviderName)}`,
    });
  }
}

/**
 * Log per-agent-definition model/provider configurations.
 */
function logAgentDefinitions(
  cfg: ReturnType<typeof loadConfig>,
  log: { info: (msg: string, meta?: Record<string, unknown>) => void },
): void {
  const agentIds = listAgentIds(cfg);

  // Skip if there are no custom agents defined (only the implicit "main" agent)
  if (agentIds.length === 1 && agentIds[0] === "main") {
    return;
  }

  for (const agentId of agentIds) {
    const agentModelRaw = resolveAgentModelPrimary(cfg, agentId);
    if (!agentModelRaw) {
      // Agent uses default model, no need to log
      continue;
    }

    const parsed = parseModelRef(agentModelRaw, DEFAULT_PROVIDER);
    const modelRef = parsed ? `${parsed.provider}/${parsed.model}` : agentModelRaw;

    log.info(`agent "${agentId}" model: ${modelRef}`, {
      consoleMessage: `agent "${chalk.yellow(agentId)}" model: ${chalk.whiteBright(modelRef)}`,
    });
  }
}
