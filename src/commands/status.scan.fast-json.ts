import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import type { StatusScanResult } from "./status.scan.js";
import {
  buildTailscaleHttpsUrl,
  pickGatewaySelfPresence,
  resolveGatewayProbeSnapshot,
  resolveMemoryPluginStatus,
  resolveSharedMemoryStatusSnapshot,
  type MemoryPluginStatus,
  type MemoryStatusSnapshot,
} from "./status.scan.shared.js";
import type { StatusSummary } from "./status.types.js";

type AgentLocalStatuses = Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;

let pluginRegistryModulePromise: Promise<typeof import("../cli/plugin-registry.js")> | undefined;
let pluginStatusModulePromise: Promise<typeof import("../plugins/status.js")> | undefined;
let configIoModulePromise: Promise<typeof import("../config/io.js")> | undefined;
let statusSummaryModulePromise: Promise<typeof import("./status.summary.js")> | undefined;
let statusUpdateModulePromise: Promise<typeof import("./status.update.js")> | undefined;
let statusAgentLocalModulePromise: Promise<typeof import("./status.agent-local.js")> | undefined;
let commandSecretTargetsModulePromise:
  | Promise<typeof import("../cli/command-secret-targets.js")>
  | undefined;
let commandSecretGatewayModulePromise:
  | Promise<typeof import("../cli/command-secret-gateway.js")>
  | undefined;
let memorySearchModulePromise: Promise<typeof import("../agents/memory-search.js")> | undefined;
let statusScanDepsRuntimeModulePromise:
  | Promise<typeof import("./status.scan.deps.runtime.js")>
  | undefined;

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("../cli/plugin-registry.js");
  return pluginRegistryModulePromise;
}

function loadPluginStatusModule() {
  pluginStatusModulePromise ??= import("../plugins/status.js");
  return pluginStatusModulePromise;
}

function loadConfigIoModule() {
  configIoModulePromise ??= import("../config/io.js");
  return configIoModulePromise;
}

function loadStatusSummaryModule() {
  statusSummaryModulePromise ??= import("./status.summary.js");
  return statusSummaryModulePromise;
}

function loadStatusUpdateModule() {
  statusUpdateModulePromise ??= import("./status.update.js");
  return statusUpdateModulePromise;
}

function loadStatusAgentLocalModule() {
  statusAgentLocalModulePromise ??= import("./status.agent-local.js");
  return statusAgentLocalModulePromise;
}

function loadCommandSecretTargetsModule() {
  commandSecretTargetsModulePromise ??= import("../cli/command-secret-targets.js");
  return commandSecretTargetsModulePromise;
}

function loadCommandSecretGatewayModule() {
  commandSecretGatewayModulePromise ??= import("../cli/command-secret-gateway.js");
  return commandSecretGatewayModulePromise;
}

function loadMemorySearchModule() {
  memorySearchModulePromise ??= import("../agents/memory-search.js");
  return memorySearchModulePromise;
}

function loadStatusScanDepsRuntimeModule() {
  statusScanDepsRuntimeModulePromise ??= import("./status.scan.deps.runtime.js");
  return statusScanDepsRuntimeModulePromise;
}

function shouldSkipMissingConfigFastPath(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_POOL_ID !== undefined ||
    process.env.NODE_ENV === "test"
  );
}

function shouldCollectPluginCompatibility(cfg: OpenClawConfig): boolean {
  if (hasPotentialConfiguredChannels(cfg)) {
    return true;
  }
  return existsSync(resolveConfigPath(process.env));
}

function resolveDefaultMemoryStorePath(agentId: string): string {
  return path.join(resolveStateDir(process.env, os.homedir), "memory", `${agentId}.sqlite`);
}

async function resolveMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: AgentLocalStatuses;
  memoryPlugin: MemoryPluginStatus;
}): Promise<MemoryStatusSnapshot | null> {
  const { resolveMemorySearchConfig } = await loadMemorySearchModule();
  const { getMemorySearchManager } = await loadStatusScanDepsRuntimeModule();
  return await resolveSharedMemoryStatusSnapshot({
    cfg: params.cfg,
    agentStatus: params.agentStatus,
    memoryPlugin: params.memoryPlugin,
    resolveMemoryConfig: resolveMemorySearchConfig,
    getMemorySearchManager,
    requireDefaultStore: resolveDefaultMemoryStorePath,
  });
}

function hasMissingConfigFastPath(): boolean {
  return !shouldSkipMissingConfigFastPath() && !existsSync(resolveConfigPath(process.env));
}

async function readStatusSourceConfig(): Promise<OpenClawConfig> {
  if (hasMissingConfigFastPath()) {
    return {};
  }
  const { readBestEffortConfig } = await loadConfigIoModule();
  return await readBestEffortConfig();
}

async function resolveStatusConfig(params: {
  sourceConfig: OpenClawConfig;
  commandName: "status --json";
}): Promise<{ resolvedConfig: OpenClawConfig; diagnostics: string[] }> {
  if (hasMissingConfigFastPath()) {
    return { resolvedConfig: params.sourceConfig, diagnostics: [] };
  }
  const [{ resolveCommandSecretRefsViaGateway }, { getStatusCommandSecretTargetIds }] =
    await Promise.all([loadCommandSecretGatewayModule(), loadCommandSecretTargetsModule()]);
  return await resolveCommandSecretRefsViaGateway({
    config: params.sourceConfig,
    commandName: params.commandName,
    targetIds: getStatusCommandSecretTargetIds(),
    mode: "read_only_status",
  });
}

function buildLeanAgentLocalStatuses(): AgentLocalStatuses {
  return {
    defaultId: "main",
    agents: [],
    totalSessions: 0,
    bootstrapPendingCount: 0,
  };
}

function buildLeanStatusSummary(params: { agentStatus: AgentLocalStatuses }): StatusSummary {
  return {
    heartbeat: {
      defaultAgentId: params.agentStatus.defaultId,
      agents: params.agentStatus.agents.map((agent) => ({
        agentId: agent.id,
        enabled: false,
        every: "off",
        everyMs: null,
      })),
    },
    channelSummary: [],
    queuedSystemEvents: [],
    sessions: {
      paths: params.agentStatus.agents.map((agent) => agent.sessionsPath),
      count: params.agentStatus.totalSessions,
      defaults: { model: null, contextTokens: null },
      recent: [],
      byAgent: params.agentStatus.agents.map((agent) => ({
        agentId: agent.id,
        path: agent.sessionsPath,
        count: agent.sessionsCount,
        recent: [],
      })),
    },
  };
}

export async function scanStatusJsonFast(
  opts: {
    timeoutMs?: number;
    all?: boolean;
  },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  const loadedRaw = await readStatusSourceConfig();
  const { resolvedConfig: cfg, diagnostics: secretDiagnostics } = await resolveStatusConfig({
    sourceConfig: loadedRaw,
    commandName: "status --json",
  });
  if (hasPotentialConfiguredChannels(cfg)) {
    const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
    ensurePluginRegistryLoaded({ scope: "configured-channels" });
  }
  const osSummary = resolveOsSummary();
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const updateTimeoutMs = opts.all ? 6500 : 2500;
  const updatePromise = loadStatusUpdateModule().then(({ getUpdateCheckResult }) =>
    getUpdateCheckResult({
      timeoutMs: updateTimeoutMs,
      fetchGit: true,
      includeRegistry: true,
    }),
  );
  const canUseLeanSummary = hasMissingConfigFastPath() && !hasPotentialConfiguredChannels(cfg);
  const agentStatusPromise = canUseLeanSummary
    ? Promise.resolve(buildLeanAgentLocalStatuses())
    : loadStatusAgentLocalModule().then(({ getAgentLocalStatuses }) => getAgentLocalStatuses(cfg));

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

  const gatewayProbePromise = resolveGatewayProbeSnapshot({ cfg, opts });

  const [tailscaleDns, update, agentStatus, gatewaySnapshot] = await Promise.all([
    tailscaleDnsPromise,
    updatePromise,
    agentStatusPromise,
    gatewayProbePromise,
  ]);
  const summary = canUseLeanSummary
    ? buildLeanStatusSummary({ agentStatus })
    : await loadStatusSummaryModule().then(({ getStatusSummary }) =>
        getStatusSummary({ config: cfg, sourceConfig: loadedRaw }),
      );
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
  // Keep the lean `status --json` route off the memory manager/runtime graph.
  // Deep memory inspection is still available on the explicit `--all` path.
  const memory = opts.all
    ? await resolveMemoryStatusSnapshot({ cfg, agentStatus, memoryPlugin })
    : null;
  const pluginCompatibility = shouldCollectPluginCompatibility(cfg)
    ? await loadPluginStatusModule().then(({ buildPluginCompatibilityNotices }) =>
        // Keep plugin status loading off the empty-config `status --json` fast path.
        // The plugin status module pulls in the full loader graph and materially bloats
        // startup RSS even when plugin compatibility is never consulted.
        buildPluginCompatibilityNotices({ config: cfg }),
      )
    : [];

  return {
    cfg,
    sourceConfig: loadedRaw,
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
