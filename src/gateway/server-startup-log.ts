import chalk from "chalk";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { loadConfig } from "../config/config.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { collectEnabledInsecureOrDangerousFlags } from "../security/dangerous-config-flags.js";

/**
 * Check whether sandbox mode is enabled but the sandbox runtime (Docker) may
 * not be available, which would cause silent fallthrough to host execution.
 * Returns a warning string if the config is risky, or null if everything is fine.
 */
export function checkSandboxFallthroughRisk(cfg: ReturnType<typeof loadConfig>): {
  warning: string | null;
  requireAvailable: boolean;
  mode: string;
} {
  const sandbox = cfg.agents?.defaults?.sandbox;
  const mode = sandbox?.mode ?? "off";
  const requireAvailable = sandbox?.requireAvailable === true;
  if (mode === "off") {
    return { warning: null, requireAvailable, mode };
  }
  // When sandbox mode is enabled, warn if Docker availability cannot be confirmed
  // at startup. The actual Docker check is deferred (it's async), but we flag
  // the configuration risk so operators are aware of the fallthrough behavior.
  const warning =
    `sandbox mode "${mode}" is enabled but Docker availability is not guaranteed at startup. ` +
    "If Docker is unavailable, commands may silently execute on the host. " +
    "Set agents.defaults.sandbox.requireAvailable=true to fail-closed instead." +
    (requireAvailable
      ? " (requireAvailable is enabled — gateway will refuse to start if Docker is unavailable)"
      : "");
  return { warning, requireAvailable, mode };
}

export function logGatewayStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string) => void };
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
  const scheme = params.tlsEnabled ? "wss" : "ws";
  const formatHost = (host: string) => (host.includes(":") ? `[${host}]` : host);
  const hosts =
    params.bindHosts && params.bindHosts.length > 0 ? params.bindHosts : [params.bindHost];
  const listenEndpoints = hosts.map((host) => `${scheme}://${formatHost(host)}:${params.port}`);
  params.log.info(`listening on ${listenEndpoints.join(", ")} (PID ${process.pid})`);
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }

  const enabledDangerousFlags = collectEnabledInsecureOrDangerousFlags(params.cfg);
  if (enabledDangerousFlags.length > 0) {
    const warning =
      `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. ` +
      "Run `openclaw security audit`.";
    params.log.warn(warning);
  }

  // Warn about model failover safety at startup
  const fallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  const execSecurity = params.cfg.tools?.exec?.security ?? "allowlist";
  if (fallbacks.length > 0 && execSecurity !== "deny") {
    params.log.info(
      `model failover: ${fallbacks.length} fallback model(s) configured. ` +
        "Fallback models inherit the same tool access as the primary. " +
        "Run `openclaw doctor` to check for capability mismatches.",
    );
  }

  // Warn about sandbox fallthrough risk at startup
  const sandboxCheck = checkSandboxFallthroughRisk(params.cfg);
  if (sandboxCheck.warning) {
    params.log.warn(`sandbox safety: ${sandboxCheck.warning}`);
  }

  // Log command queue bounding status
  const configuredQueueSize = params.cfg.gateway?.maxCommandQueueSize;
  if (typeof configuredQueueSize === "number" && configuredQueueSize > 0) {
    params.log.info(`command queue: bounded to ${configuredQueueSize} entries per lane`);
  } else if (configuredQueueSize === 0) {
    params.log.warn(
      "command queue: unbounded (gateway.maxCommandQueueSize=0). " +
        "Sustained high-rate input may cause memory growth.",
    );
  }
}
