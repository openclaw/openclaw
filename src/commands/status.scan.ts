import { existsSync } from "node:fs";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
import { getStatusCommandSecretTargetIds } from "../cli/command-secret-targets.js";
import { withProgress } from "../cli/progress.js";
import type { OpenClawConfig } from "../config/config.js";
import { readBestEffortConfig } from "../config/config.js";
import { resolveConfigPath } from "../config/paths.js";
import type { collectChannelStatusIssues as collectChannelStatusIssuesFn } from "../infra/channels-status-issues.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import {
  buildPluginCompatibilityNotices,
  type PluginCompatibilityNotice,
} from "../plugins/status.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { createEmptyTaskAuditSummary } from "../tasks/task-registry.audit.js";
import { createEmptyTaskRegistrySummary } from "../tasks/task-registry.summary.js";
import type { buildChannelsTable as buildChannelsTableFn } from "./status-all/channels.js";
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import { buildColdStartUpdateResult, scanStatusJsonCore } from "./status.scan.json-core.js";
import {
  buildTailscaleHttpsUrl,
  pickGatewaySelfPresence,
  resolveGatewayProbeSnapshot,
  resolveMemoryPluginStatus,
  resolveSharedMemoryStatusSnapshot,
  type GatewayProbeSnapshot,
  type MemoryPluginStatus,
  type MemoryStatusSnapshot,
} from "./status.scan.shared.js";
import type { getStatusSummary as getStatusSummaryFn } from "./status.summary.js";

type DeferredResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

let statusScanDepsRuntimeModulePromise:
  | Promise<typeof import("./status.scan.deps.runtime.js")>
  | undefined;
let statusAgentLocalModulePromise: Promise<typeof import("./status.agent-local.js")> | undefined;
let statusSummaryModulePromise: Promise<typeof import("./status.summary.js")> | undefined;
let statusUpdateModulePromise: Promise<typeof import("./status.update.js")> | undefined;
let gatewayCallModulePromise: Promise<typeof import("../gateway/call.js")> | undefined;

const loadStatusScanRuntimeModule = createLazyRuntimeSurface(
  () => import("./status.scan.runtime.js"),
  ({ statusScanRuntime }) => statusScanRuntime,
);

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

function loadGatewayCallModule() {
  gatewayCallModulePromise ??= import("../gateway/call.js");
  return gatewayCallModulePromise;
}

function deferResult<T>(promise: Promise<T>): Promise<DeferredResult<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

function unwrapDeferredResult<T>(result: DeferredResult<T>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function isMissingConfigColdStart(): boolean {
  return !existsSync(resolveConfigPath(process.env));
}

async function resolveChannelsStatus(params: {
  cfg: OpenClawConfig;
  gatewayReachable: boolean;
  opts: { timeoutMs?: number; all?: boolean };
}) {
  if (!params.gatewayReachable) {
    return null;
  }
  const { callGateway } = await loadGatewayCallModule();
  return await callGateway({
    config: params.cfg,
    method: "channels.status",
    params: {
      probe: false,
      timeoutMs: Math.min(8000, params.opts.timeoutMs ?? 10_000),
    },
    timeoutMs: Math.min(params.opts.all ? 5000 : 2500, params.opts.timeoutMs ?? 10_000),
  }).catch(() => null);
}

export type StatusScanResult = {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  secretDiagnostics: string[];
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  update: UpdateCheckResult;
  gatewayConnection: GatewayProbeSnapshot["gatewayConnection"];
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  gatewayProbeAuthWarning?: string;
  gatewayProbe: GatewayProbeSnapshot["gatewayProbe"];
  gatewayReachable: boolean;
  gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
  channelIssues: ReturnType<typeof collectChannelStatusIssuesFn>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
  channels: Awaited<ReturnType<typeof buildChannelsTableFn>>;
  summary: Awaited<ReturnType<typeof getStatusSummaryFn>>;
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
  pluginCompatibility: PluginCompatibilityNotice[];
};

async function resolveMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
  memoryPlugin: MemoryPluginStatus;
}): Promise<MemoryStatusSnapshot | null> {
  const { getMemorySearchManager } = await loadStatusScanDepsRuntimeModule();
  return await resolveSharedMemoryStatusSnapshot({
    cfg: params.cfg,
    agentStatus: params.agentStatus,
    memoryPlugin: params.memoryPlugin,
    resolveMemoryConfig: resolveMemorySearchConfig,
    getMemorySearchManager,
  });
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

async function scanStatusJsonFast(opts: {
  timeoutMs?: number;
  all?: boolean;
  runtime: RuntimeEnv;
}): Promise<StatusScanResult> {
  const coldStart = isMissingConfigColdStart();
  const loadedRaw = await readBestEffortConfig();
  const { resolvedConfig: cfg, diagnostics: secretDiagnostics } =
    await resolveCommandSecretRefsViaGateway({
      config: loadedRaw,
      commandName: "status --json",
      targetIds: getStatusCommandSecretTargetIds(),
      mode: "read_only_status",
    });
  return await scanStatusJsonCore({
    coldStart,
    cfg,
    sourceConfig: loadedRaw,
    secretDiagnostics,
    hasConfiguredChannels: hasPotentialConfiguredChannels(cfg),
    opts,
    resolveOsSummary,
    resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
      await resolveMemoryStatusSnapshot({ cfg, agentStatus, memoryPlugin }),
    runtime: opts.runtime,
  });
}

export async function scanStatus(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  if (opts.json) {
    return await scanStatusJsonFast({
      timeoutMs: opts.timeoutMs,
      all: opts.all,
      runtime: _runtime,
    });
  }
  return await withProgress(
    {
      label: "Scanning status…",
      total: 11,
      enabled: true,
    },
    async (progress) => {
      const coldStart = isMissingConfigColdStart();
      progress.setLabel("Loading config…");
      const loadedRaw = await readBestEffortConfig();
      const { resolvedConfig: cfg, diagnostics: secretDiagnostics } =
        await resolveCommandSecretRefsViaGateway({
          config: loadedRaw,
          commandName: "status",
          targetIds: getStatusCommandSecretTargetIds(),
          mode: "read_only_status",
        });
      const hasConfiguredChannels = hasPotentialConfiguredChannels(cfg);
      const skipColdStartNetworkChecks = coldStart && !hasConfiguredChannels && opts.all !== true;
      const osSummary = resolveOsSummary();
      const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
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
      const updateTimeoutMs = opts.all ? 6500 : 2500;
      const updatePromise = deferResult(
        skipColdStartNetworkChecks
          ? Promise.resolve(buildColdStartUpdateResult())
          : loadStatusUpdateModule().then(({ getUpdateCheckResult }) =>
              getUpdateCheckResult({
                timeoutMs: updateTimeoutMs,
                fetchGit: true,
                includeRegistry: true,
              }),
            ),
      );
      const agentStatusPromise = deferResult(
        skipColdStartNetworkChecks
          ? Promise.resolve(buildColdStartAgentLocalStatuses())
          : loadStatusAgentLocalModule().then(({ getAgentLocalStatuses }) =>
              getAgentLocalStatuses(cfg),
            ),
      );
      const summaryPromise = deferResult(
        skipColdStartNetworkChecks
          ? Promise.resolve(buildColdStartStatusSummary())
          : loadStatusSummaryModule().then(({ getStatusSummary }) =>
              getStatusSummary({ config: cfg, sourceConfig: loadedRaw }),
            ),
      );
      progress.tick();

      progress.setLabel("Checking Tailscale…");
      const tailscaleDns = await tailscaleDnsPromise;
      const tailscaleHttpsUrl = buildTailscaleHttpsUrl({
        tailscaleMode,
        tailscaleDns,
        controlUiBasePath: cfg.gateway?.controlUi?.basePath,
      });
      progress.tick();

      progress.setLabel("Checking for updates…");
      const update = unwrapDeferredResult(await updatePromise);
      progress.tick();

      progress.setLabel("Resolving agents…");
      const agentStatus = unwrapDeferredResult(await agentStatusPromise);
      progress.tick();

      progress.setLabel("Probing gateway…");
      const {
        gatewayConnection,
        remoteUrlMissing,
        gatewayMode,
        gatewayProbeAuth,
        gatewayProbeAuthWarning,
        gatewayProbe,
      } = await resolveGatewayProbeSnapshot({
        cfg,
        opts: {
          ...opts,
          ...(skipColdStartNetworkChecks ? { skipProbe: true } : {}),
        },
      });
      const gatewayReachable = gatewayProbe?.ok === true;
      const gatewaySelf = gatewayProbe?.presence
        ? pickGatewaySelfPresence(gatewayProbe.presence)
        : null;
      progress.tick();

      progress.setLabel("Querying channel status…");
      const channelsStatus = await resolveChannelsStatus({ cfg, gatewayReachable, opts });
      const { collectChannelStatusIssues, buildChannelsTable } =
        await loadStatusScanRuntimeModule();
      const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
      progress.tick();

      progress.setLabel("Summarizing channels…");
      const channels = await buildChannelsTable(cfg, {
        // Show token previews in regular status; keep `status --all` redacted.
        // Set `OPENCLAW_SHOW_SECRETS=0` to force redaction.
        showSecrets: process.env.OPENCLAW_SHOW_SECRETS?.trim() !== "0",
        sourceConfig: loadedRaw,
      });
      progress.tick();

      progress.setLabel("Checking memory…");
      const memoryPlugin = resolveMemoryPluginStatus(cfg);
      const memory = await resolveMemoryStatusSnapshot({ cfg, agentStatus, memoryPlugin });
      progress.tick();

      progress.setLabel("Checking plugins…");
      const pluginCompatibility = buildPluginCompatibilityNotices({ config: cfg });
      progress.tick();

      progress.setLabel("Reading sessions…");
      const summary = unwrapDeferredResult(await summaryPromise);
      progress.tick();

      progress.setLabel("Rendering…");
      progress.tick();

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
        channelIssues,
        agentStatus,
        channels,
        summary,
        memory,
        memoryPlugin,
        pluginCompatibility,
      };
    },
  );
}
