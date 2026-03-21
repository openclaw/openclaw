import fs, { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { resolveConfigPath, resolveGatewayPort, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { StatusScanResult } from "./status.scan.js";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";

const DEFAULT_AGENT_ID = "main";
const DEFAULT_AGENT_WORKSPACE_DIRNAME = "workspace";
const DEFAULT_HEARTBEAT_EVERY = "30m";
const DEFAULT_HEARTBEAT_EVERY_MS = 30 * 60 * 1000;
const DEFAULT_MODEL = "claude-opus-4-6";
const DEFAULT_CONTEXT_TOKENS = 200_000;

type AgentLocalStatus = {
  id: string;
  name?: string;
  workspaceDir: string | null;
  bootstrapPending: boolean | null;
  sessionsPath: string;
  sessionsCount: number;
  lastUpdatedAt: number | null;
  lastActiveAgeMs: number | null;
};

type AgentLocalStatusesResult = {
  defaultId: string;
  agents: AgentLocalStatus[];
  totalSessions: number;
  bootstrapPendingCount: number;
};

type GatewayProbeResultLite = {
  ok: boolean;
  url: string;
  connectLatencyMs: number | null;
  error: string | null;
  close: null;
  health: null;
  status: null;
  presence: null;
  configSnapshot: null;
};

let pluginRegistryModulePromise: Promise<typeof import("../cli/plugin-registry.js")> | undefined;
let pluginStatusModulePromise: Promise<typeof import("../plugins/status.js")> | undefined;
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
let statusAgentLocalModulePromise: Promise<typeof import("./status.agent-local.js")> | undefined;
let statusSummaryModulePromise: Promise<typeof import("./status.summary.js")> | undefined;
let statusScanSharedModulePromise: Promise<typeof import("./status.scan.shared.js")> | undefined;
let statusUpdateModulePromise: Promise<typeof import("./status.update.js")> | undefined;
let processExecModulePromise: Promise<typeof import("../process/exec.js")> | undefined;
let osSummaryModulePromise: Promise<typeof import("../infra/os-summary.js")> | undefined;

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

function loadAgentLocalModule() {
  statusAgentLocalModulePromise ??= import("./status.agent-local.js");
  return statusAgentLocalModulePromise;
}

function loadStatusSummaryModule() {
  statusSummaryModulePromise ??= import("./status.summary.js");
  return statusSummaryModulePromise;
}

function loadStatusScanDepsRuntimeModule() {
  statusScanDepsRuntimeModulePromise ??= import("./status.scan.deps.runtime.js");
  return statusScanDepsRuntimeModulePromise;
}

function loadStatusScanSharedModule() {
  statusScanSharedModulePromise ??= import("./status.scan.shared.js");
  return statusScanSharedModulePromise;
}

function loadStatusUpdateModule() {
  statusUpdateModulePromise ??= import("./status.update.js");
  return statusUpdateModulePromise;
}

function loadProcessExecModule() {
  processExecModulePromise ??= import("../process/exec.js");
  return processExecModulePromise;
}

function loadOsSummaryModule() {
  osSummaryModulePromise ??= import("../infra/os-summary.js");
  return osSummaryModulePromise;
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

function isPlainEmptyObject(value: unknown): value is Record<string, never> {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function resolveDefaultWorkspaceDirLite(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home =
    env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", DEFAULT_AGENT_WORKSPACE_DIRNAME);
}

function resolveDefaultSessionsPathLite(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    resolveStateDir(env, os.homedir),
    "agents",
    DEFAULT_AGENT_ID,
    "sessions",
    "sessions.json",
  );
}

function readSessionStoreLite(
  storePath: string,
): Record<string, { updatedAt?: number } | undefined> {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    if (!raw.trim()) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, { updatedAt?: number } | undefined>)
      : {};
  } catch {
    return {};
  }
}

function canUseUltraLeanEmptyConfigFastPath(params: {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  all?: boolean;
}): boolean {
  if (params.all) {
    return false;
  }
  if (!isPlainEmptyObject(params.cfg) || !isPlainEmptyObject(params.sourceConfig)) {
    return false;
  }
  if (process.env.OPENCLAW_GATEWAY_URL?.trim() || process.env.CLAWDBOT_GATEWAY_URL?.trim()) {
    return false;
  }
  const agentsDir = path.join(resolveStateDir(process.env, os.homedir), "agents");
  if (existsSync(agentsDir)) {
    return false;
  }
  return true;
}

function buildUltraLeanEmptyStatusSummary(
  agentStatus: AgentLocalStatusesResult,
  sessionsPath: string,
): StatusScanResult["summary"] {
  return {
    runtimeVersion:
      process.env.OPENCLAW_VERSION?.trim() ||
      process.env.OPENCLAW_SERVICE_VERSION?.trim() ||
      "unknown",
    heartbeat: {
      defaultAgentId: agentStatus.defaultId,
      agents: [
        {
          agentId: agentStatus.defaultId,
          enabled: true,
          every: DEFAULT_HEARTBEAT_EVERY,
          everyMs: DEFAULT_HEARTBEAT_EVERY_MS,
        },
      ],
    },
    channelSummary: [],
    queuedSystemEvents: [],
    sessions: {
      paths: [sessionsPath],
      count: agentStatus.totalSessions,
      defaults: {
        model: DEFAULT_MODEL,
        contextTokens: DEFAULT_CONTEXT_TOKENS,
      },
      recent: [],
      byAgent: [
        {
          agentId: agentStatus.defaultId,
          path: sessionsPath,
          count: agentStatus.totalSessions,
          recent: [],
        },
      ],
    },
  };
}

function resolveOsSummaryLite() {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  return {
    platform,
    arch,
    release,
    label:
      platform === "darwin"
        ? `macos ${release} (${arch})`
        : platform === "win32"
          ? `windows ${release} (${arch})`
          : `${platform} ${release} (${arch})`,
  };
}

async function buildUltraLeanEmptyAgentStatus(): Promise<AgentLocalStatusesResult> {
  const workspaceDir = resolveDefaultWorkspaceDirLite();
  const bootstrapPending = existsSync(path.join(workspaceDir, "BOOTSTRAP.md"));
  const sessionsPath = resolveDefaultSessionsPathLite();
  const store = readSessionStoreLite(sessionsPath);
  const sessions = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([, entry]) => entry);
  const sessionsCount = sessions.length;
  const lastUpdatedAt = sessions.reduce((max, entry) => Math.max(max, entry?.updatedAt ?? 0), 0);
  const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
  const lastActiveAgeMs = resolvedLastUpdatedAt ? Date.now() - resolvedLastUpdatedAt : null;
  return {
    defaultId: DEFAULT_AGENT_ID,
    agents: [
      {
        id: DEFAULT_AGENT_ID,
        workspaceDir,
        bootstrapPending,
        sessionsPath,
        sessionsCount,
        lastUpdatedAt: resolvedLastUpdatedAt,
        lastActiveAgeMs,
      },
    ],
    totalSessions: sessionsCount,
    bootstrapPendingCount: bootstrapPending ? 1 : 0,
  };
}

async function probeLoopbackGatewayLite(params: {
  port: number;
  timeoutMs?: number;
}): Promise<GatewayProbeResultLite> {
  const url = `ws://127.0.0.1:${params.port}`;
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host: "127.0.0.1", port: params.port });
    const finish = (result: Omit<GatewayProbeResultLite, "url">) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ url, ...result });
    };
    socket.once("connect", () => {
      finish({
        ok: true,
        connectLatencyMs: Date.now() - startedAt,
        error: null,
        close: null,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      });
    });
    socket.once("error", (error) => {
      finish({
        ok: false,
        connectLatencyMs: null,
        error: error instanceof Error ? error.message : String(error),
        close: null,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      });
    });
    socket.setTimeout(Math.min(2500, params.timeoutMs ?? 10_000), () => {
      finish({
        ok: false,
        connectLatencyMs: null,
        error: "timeout",
        close: null,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      });
    });
  });
}

async function resolveMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: AgentLocalStatusesResult;
  memoryPlugin: MemoryPluginStatus;
}): Promise<MemoryStatusSnapshot | null> {
  const { resolveSharedMemoryStatusSnapshot } = await loadStatusScanSharedModule();
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
  if (canUseUltraLeanEmptyConfigFastPath({ cfg, sourceConfig: loadedRaw, all: opts.all })) {
    const { getUpdateCheckResult } = await loadStatusUpdateModule();
    const osSummary = resolveOsSummaryLite();
    const update = await getUpdateCheckResult({
      timeoutMs: opts.all ? 6500 : 2500,
      fetchGit: true,
      includeRegistry: true,
    });
    const agentStatus = await buildUltraLeanEmptyAgentStatus();
    const gatewayPort = resolveGatewayPort(cfg);
    const gatewayProbe = await probeLoopbackGatewayLite({
      port: gatewayPort,
      timeoutMs: opts.timeoutMs,
    });
    const sessionsPath = agentStatus.agents[0]?.sessionsPath ?? resolveDefaultSessionsPathLite();
    return {
      cfg,
      sourceConfig: loadedRaw,
      secretDiagnostics,
      osSummary,
      tailscaleMode: "off",
      tailscaleDns: null,
      tailscaleHttpsUrl: null,
      update,
      gatewayConnection: {
        url: `ws://127.0.0.1:${gatewayPort}`,
        urlSource: "local loopback",
        bindDetail: "Bind: loopback",
        message: [
          `Gateway target: ws://127.0.0.1:${gatewayPort}`,
          "Source: local loopback",
          `Config: ${resolveConfigPath(process.env)}`,
          "Bind: loopback",
        ].join("\n"),
      },
      remoteUrlMissing: false,
      gatewayMode: "local",
      gatewayProbeAuth: {},
      gatewayProbeAuthWarning: undefined,
      gatewayProbe,
      gatewayReachable: gatewayProbe.ok,
      gatewaySelf: null,
      channelIssues: [],
      agentStatus,
      channels: { rows: [], details: [] },
      summary: buildUltraLeanEmptyStatusSummary(agentStatus, sessionsPath),
      memory: null,
      memoryPlugin: {
        enabled: true,
        slot: "memory-core",
      },
      pluginCompatibility: [],
    };
  }
  if (hasPotentialConfiguredChannels(cfg)) {
    const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
    ensurePluginRegistryLoaded({ scope: "configured-channels" });
  }
  const [
    { resolveOsSummary },
    { getUpdateCheckResult },
    { getAgentLocalStatuses },
    scanShared,
    { getStatusSummary },
  ] = await Promise.all([
    loadOsSummaryModule(),
    loadStatusUpdateModule(),
    loadAgentLocalModule(),
    loadStatusScanSharedModule(),
    loadStatusSummaryModule(),
  ]);
  const osSummary = resolveOsSummary();
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const updateTimeoutMs = opts.all ? 6500 : 2500;
  const updatePromise = getUpdateCheckResult({
    timeoutMs: updateTimeoutMs,
    fetchGit: true,
    includeRegistry: true,
  });
  const agentStatusPromise = getAgentLocalStatuses(cfg);
  const summaryPromise = getStatusSummary({ config: cfg, sourceConfig: loadedRaw });

  const tailscaleDnsPromise =
    tailscaleMode === "off"
      ? Promise.resolve<string | null>(null)
      : loadStatusScanDepsRuntimeModule()
          .then(({ getTailnetHostname }) =>
            loadProcessExecModule().then(({ runExec }) =>
              getTailnetHostname((cmd, args) =>
                runExec(cmd, args, { timeoutMs: 1200, maxBuffer: 200_000 }),
              ),
            ),
          )
          .catch(() => null);

  const gatewayProbePromise = scanShared.resolveGatewayProbeSnapshot({ cfg, opts });

  const [tailscaleDns, update, agentStatus, gatewaySnapshot, summary] = await Promise.all([
    tailscaleDnsPromise,
    updatePromise,
    agentStatusPromise,
    gatewayProbePromise,
    summaryPromise,
  ]);
  const tailscaleHttpsUrl = scanShared.buildTailscaleHttpsUrl({
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
    ? scanShared.pickGatewaySelfPresence(gatewayProbe.presence)
    : null;
  const memoryPlugin = scanShared.resolveMemoryPluginStatus(cfg);
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
