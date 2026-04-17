import chalk from "chalk";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { collectEnabledInsecureOrDangerousFlags } from "../security/dangerous-config-flags.js";

export function logGatewayStartup(params: {
  cfg: OpenClawConfig;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  loadedPluginIds: readonly string[];
  startupStartedAt?: number;
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
  const startupDurationMs =
    typeof params.startupStartedAt === "number" ? Date.now() - params.startupStartedAt : null;
  const startupDurationLabel =
    startupDurationMs == null ? null : `${(startupDurationMs / 1000).toFixed(1)}s`;
  params.log.info(`ready (${formatReadyDetails(params.loadedPluginIds, startupDurationLabel)})`);
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

  const proxyWarning = collectProxyEnvMismatch(params.cfg);
  if (proxyWarning) {
    params.log.warn(proxyWarning);
  }
}

function isLocalProviderUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function collectProxyEnvMismatch(cfg: OpenClawConfig): string | null {
  if (!hasProxyEnvConfigured()) {
    return null;
  }

  const providers = cfg.models?.providers ?? {};
  const unconfigured: string[] = [];

  for (const [name, provider] of Object.entries(providers)) {
    if (isLocalProviderUrl(provider.baseUrl)) {
      continue;
    }
    if (!provider.request?.proxy) {
      unconfigured.push(name);
    }
  }

  if (unconfigured.length === 0) {
    return null;
  }

  return (
    `proxy env detected (HTTP_PROXY/HTTPS_PROXY) but not used by providers: ${unconfigured.join(", ")}. ` +
    `Consider setting models.providers.<name>.request.proxy.mode = "env-proxy"`
  );
}

function formatReadyDetails(
  loadedPluginIds: readonly string[],
  startupDurationLabel: string | null,
) {
  const pluginIds = [...new Set(loadedPluginIds.map((id) => id.trim()).filter(Boolean))].toSorted(
    (a, b) => a.localeCompare(b),
  );
  const pluginSummary =
    pluginIds.length === 0
      ? "0 plugins"
      : `${pluginIds.length} ${pluginIds.length === 1 ? "plugin" : "plugins"}: ${pluginIds.join(", ")}`;

  if (!startupDurationLabel) {
    return pluginSummary;
  }
  return pluginIds.length === 0
    ? `${pluginSummary}, ${startupDurationLabel}`
    : `${pluginSummary}; ${startupDurationLabel}`;
}
