import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { loggingState } from "../logging/state.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { createEmptyTaskAuditSummary } from "../tasks/task-registry.audit.js";
import { createEmptyTaskRegistrySummary } from "../tasks/task-registry.summary.js";
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import type { StatusScanResult } from "./status.scan.js";
import {
  buildTailscaleHttpsUrl,
  pickGatewaySelfPresence,
  resolveGatewayProbeSnapshot,
  resolveMemoryPluginStatus,
} from "./status.scan.shared.js";
import type { getStatusSummary as getStatusSummaryFn } from "./status.summary.js";

let pluginRegistryModulePromise: Promise<typeof import("../cli/plugin-registry.js")> | undefined;
let statusScanDepsRuntimeModulePromise:
  | Promise<typeof import("./status.scan.deps.runtime.js")>
  | undefined;
let statusAgentLocalModulePromise: Promise<typeof import("./status.agent-local.js")> | undefined;
let statusSummaryModulePromise: Promise<typeof import("./status.summary.js")> | undefined;
let statusUpdateModulePromise: Promise<typeof import("./status.update.js")> | undefined;

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("../cli/plugin-registry.js");
  return pluginRegistryModulePromise;
}

function loadStatusScanDepsRuntimeModule() {
  statusScanDepsRuntimeModulePromise ??= import("./status.scan.deps.runtime.js");
  return statusScanDepsRuntimeModulePromise;
}

function loadStatusAgentLocalModule() {
  statusAgentLocalModulePromise ??= import("./status.agent-local.js");
  return statusAgentLocalModulePromise;
}

function loadStatusSummaryModule() {
  statusSummaryModulePromise ??= import("./status.summary.js");
  return statusSummaryModulePromise;
}

function loadStatusUpdateModule() {
  statusUpdateModulePromise ??= import("./status.update.js");
  return statusUpdateModulePromise;
}

export function buildColdStartUpdateResult(): UpdateCheckResult {
  return {
    root: null,
    installKind: "unknown",
    packageManager: "unknown",
  };
}

function buildColdStartAgentLocalStatuses(): Awaited<ReturnType<typeof getAgentLocalStatusesFn>> {
  return {
    defaultId: "main",
    agents: [],
    totalSessions: 0,
    bootstrapPendingCount: 0,
  };
}

function buildColdStartStatusSummary(): Awaited<ReturnType<typeof getStatusSummaryFn>> {
  return {
    runtimeVersion: null,
    heartbeat: {
      defaultAgentId: "main",
      agents: [],
    },
    channelSummary: [],
    queuedSystemEvents: [],
    tasks: createEmptyTaskRegistrySummary(),
    taskAudit: createEmptyTaskAuditSummary(),
    sessions: {
      paths: [],
      count: 0,
      defaults: { model: null, contextTokens: null },
      recent: [],
      byAgent: [],
    },
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
    agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
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
    : loadStatusUpdateModule().then(({ getUpdateCheckResult }) =>
        getUpdateCheckResult({
          timeoutMs: updateTimeoutMs,
          fetchGit: true,
          includeRegistry: true,
        }),
      );
  const agentStatusPromise = skipColdStartNetworkChecks
    ? Promise.resolve(buildColdStartAgentLocalStatuses())
    : loadStatusAgentLocalModule().then(({ getAgentLocalStatuses }) => getAgentLocalStatuses(cfg));
  const summaryPromise = skipColdStartNetworkChecks
    ? Promise.resolve(buildColdStartStatusSummary())
    : loadStatusSummaryModule().then(({ getStatusSummary }) =>
        getStatusSummary({ config: cfg, sourceConfig }),
      );
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
