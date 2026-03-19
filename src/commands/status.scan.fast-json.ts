import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import { buildPluginCompatibilityNotices } from "../plugins/status.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import type { StatusScanResult } from "./status.scan.js";
import {
  buildTailscaleHttpsUrl,
  resolveGatewayProbeSnapshot,
  resolveMemoryPluginStatus,
  resolveSharedMemoryStatusSnapshot,
  type MemoryPluginStatus,
  type MemoryStatusSnapshot,
} from "./status.scan.shared.js";
let pluginRegistryModulePromise: Promise<typeof import("../cli/plugin-registry.js")> | undefined;
let configIoModulePromise: Promise<typeof import("../config/io.js")> | undefined;
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
let statusSummaryModulePromise: Promise<typeof import("./status.summary.js")> | undefined;
let agentLocalModulePromise: Promise<typeof import("./status.agent-local.js")> | undefined;
let updateCheckModulePromise: Promise<typeof import("./status.update.js")> | undefined;
let gatewayProbeHelpersModulePromise:
  | Promise<typeof import("./status.gateway-probe.js")>
  | undefined;

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("../cli/plugin-registry.js");
  return pluginRegistryModulePromise;
}

function loadConfigIoModule() {
  configIoModulePromise ??= import("../config/io.js");
  return configIoModulePromise;
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

function loadStatusSummaryModule() {
  statusSummaryModulePromise ??= import("./status.summary.js");
  return statusSummaryModulePromise;
}

function loadAgentLocalModule() {
  agentLocalModulePromise ??= import("./status.agent-local.js");
  return agentLocalModulePromise;
}

function loadUpdateCheckModule() {
  updateCheckModulePromise ??= import("./status.update.js");
  return updateCheckModulePromise;
}

function loadGatewayProbeHelpersModule() {
  gatewayProbeHelpersModulePromise ??= import("./status.gateway-probe.js");
  return gatewayProbeHelpersModulePromise;
}

function shouldSkipMissingConfigFastPath(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_POOL_ID !== undefined ||
    process.env.NODE_ENV === "test"
  );
}

function resolveDefaultMemoryStorePath(agentId: string): string {
  return path.join(resolveStateDir(process.env, os.homedir), "memory", `${agentId}.sqlite`);
}

async function resolveMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: { defaultId: string | null };
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

async function readStatusSourceConfig(): Promise<OpenClawConfig> {
  if (!shouldSkipMissingConfigFastPath() && !existsSync(resolveConfigPath(process.env))) {
    return {};
  }
  const { readBestEffortConfig } = await loadConfigIoModule();
  return await readBestEffortConfig();
}

async function resolveStatusConfig(params: {
  sourceConfig: OpenClawConfig;
  commandName: "status --json";
}): Promise<{ resolvedConfig: OpenClawConfig; diagnostics: string[] }> {
  if (!shouldSkipMissingConfigFastPath() && !existsSync(resolveConfigPath(process.env))) {
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
  const updatePromise = loadUpdateCheckModule().then(({ getUpdateCheckResult }) =>
    getUpdateCheckResult({
      timeoutMs: updateTimeoutMs,
      fetchGit: true,
      includeRegistry: true,
    }),
  );
  const agentStatusPromise = loadAgentLocalModule().then(({ getAgentLocalStatuses }) =>
    getAgentLocalStatuses(cfg),
  );
  const summaryPromise = loadStatusSummaryModule().then(({ getStatusSummary }) =>
    getStatusSummary({ config: cfg, sourceConfig: loadedRaw }),
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

  const gatewayProbePromise = resolveGatewayProbeSnapshot({ cfg, opts });

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
  const { pickGatewaySelfPresence } = await loadGatewayProbeHelpersModule();
  const gatewaySelf = gatewayProbe?.presence
    ? pickGatewaySelfPresence(gatewayProbe.presence)
    : null;
  const memoryPlugin = resolveMemoryPluginStatus(cfg);
  const memory = await resolveMemoryStatusSnapshot({ cfg, agentStatus, memoryPlugin });
  const pluginCompatibility = buildPluginCompatibilityNotices({ config: cfg });

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
