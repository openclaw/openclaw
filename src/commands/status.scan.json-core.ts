import type { OpenClawConfig } from "../config/types.js";
import { loggingState } from "../logging/state.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { getAgentLocalStatuses } from "./status.agent-local.js";
import type { StatusScanResult } from "./status.scan.js";
import {
  buildTailscaleHttpsUrl,
  pickGatewaySelfPresence,
  resolveGatewayProbeSnapshot,
  resolveMemoryPluginStatus,
} from "./status.scan.shared.js";
import { getStatusSummary } from "./status.summary.js";
import { getUpdateCheckResult } from "./status.update.js";

let pluginRegistryModulePromise: Promise<typeof import("../cli/plugin-registry.js")> | undefined;
let statusScanDepsRuntimeModulePromise:
  | Promise<typeof import("./status.scan.deps.runtime.js")>
  | undefined;

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("../cli/plugin-registry.js");
  return pluginRegistryModulePromise;
}

function loadStatusScanDepsRuntimeModule() {
  statusScanDepsRuntimeModulePromise ??= import("./status.scan.deps.runtime.js");
  return statusScanDepsRuntimeModulePromise;
}

export function buildColdStartUpdateResult(): Awaited<ReturnType<typeof getUpdateCheckResult>> {
  return {
    root: null,
    installKind: "unknown",
    packageManager: "unknown",
  };
}

export async function scanStatusJsonCore(params: {
  coldStart: boolean;
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  secretDiagnostics: string[];
  hasConfiguredChannels: boolean;
  opts: { timeoutMs?: number; all?: boolean };
  resolveOsSummary: () => StatusScanResult["osSummary"];
  resolveMemory: (args: {
    cfg: OpenClawConfig;
    agentStatus: Awaited<ReturnType<typeof getAgentLocalStatuses>>;
    memoryPlugin: StatusScanResult["memoryPlugin"];
    runtime: RuntimeEnv;
  }) => Promise<StatusScanResult["memory"]>;
  runtime: RuntimeEnv;
}): Promise<StatusScanResult> {
  const { cfg, sourceConfig, secretDiagnostics, hasConfiguredChannels, opts } = params;
  if (hasConfiguredChannels) {
    const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
    // Route plugin registration logs to stderr so they don't corrupt JSON on stdout.
    const previousForceStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = true;
    try {
      ensurePluginRegistryLoaded({ scope: "configured-channels" });
    } finally {
      loggingState.forceConsoleToStderr = previousForceStderr;
    }
  }

  const osSummary = params.resolveOsSummary();
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const updateTimeoutMs = opts.all ? 6500 : 2500;
  const skipColdStartNetworkChecks =
    params.coldStart && !hasConfiguredChannels && opts.all !== true;
  const updatePromise = skipColdStartNetworkChecks
    ? Promise.resolve(buildColdStartUpdateResult())
    : getUpdateCheckResult({
        timeoutMs: updateTimeoutMs,
        fetchGit: true,
        includeRegistry: true,
      });
  const agentStatusPromise = getAgentLocalStatuses(cfg);
  const summaryPromise = getStatusSummary({ config: cfg, sourceConfig });
  const tailscaleDnsPromise =
    tailscaleMode === "off"
      ? Promise.resolve<string | null>(null)
      : loadStatusScanDepsRuntimeModule()
          .then(({ getTailnetHostname }) =>
            getTailnetHostname((cmd, args) =>
              runExec(cmd, args, { timeoutMs: 1200, maxBuffer: 200_000 }),
            ),
          )
          .catch(() => null);
  const gatewayProbePromise = resolveGatewayProbeSnapshot({
    cfg,
    opts: {
      ...opts,
      ...(skipColdStartNetworkChecks ? { skipProbe: true } : {}),
    },
  });

  const [tailscaleDns, update, agentStatus, gatewaySnapshot, summary] = await Promise.all([
    tailscaleDnsPromise,
    updatePromise,
    agentStatusPromise,
    gatewayProbePromise,
    summaryPromise,
  ]);
  const tailscaleHttpsUrl = buildTailscaleHttpsUrl({
    tailscaleMode,
    tailscaleDns,
    controlUiBasePath: cfg.gateway?.controlUi?.basePath,
  });

  const {
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth,
    gatewayProbeAuthWarning,
    gatewayProbe,
  } = gatewaySnapshot;
  const gatewayReachable = gatewayProbe?.ok === true;
  const gatewaySelf = gatewayProbe?.presence
    ? pickGatewaySelfPresence(gatewayProbe.presence)
    : null;
  const memoryPlugin = resolveMemoryPluginStatus(cfg);
  const memory = await params.resolveMemory({
    cfg,
    agentStatus,
    memoryPlugin,
    runtime: params.runtime,
  });
  // `status --json` does not serialize plugin compatibility notices, so keep
  // both routes off the full plugin status graph after the scoped preload.
  const pluginCompatibility: StatusScanResult["pluginCompatibility"] = [];

  return {
    cfg,
    sourceConfig,
    secretDiagnostics,
    osSummary,
    tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    update,
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth,
    gatewayProbeAuthWarning,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    channelIssues: [],
    agentStatus,
    channels: { rows: [], details: [] },
    summary,
    memory,
    memoryPlugin,
    pluginCompatibility,
  };
}
