import { withProgress } from "../cli/progress.js";
/**
 * status.command.ts
 *
 * OpenClaw 状态命令核心实现模块
 *
 * 本模块实现 `openclaw status` 命令的主要逻辑。
 * 该命令用于显示 OpenClaw Gateway 和相关服务的运行状态。
 *
 * 主要功能：
 * - 执行系统状态扫描和检测
 * - 显示 Gateway 连接状态和健康信息
 * - 显示 Agent 和 Channel 的运行状态
 * - 显示资源使用情况和安全审计信息
 * - 支持 JSON 格式输出（用于脚本和 API）
 * - 支持 --all 参数显示所有详细信息
 *
 * 命令选项：
 * - --json: JSON 格式输出
 * - --deep: 深度扫描模式
 * - --usage: 显示资源使用情况
 * - --all: 显示所有详细信息
 */

import {
  normalizePairingConnectRequestId,
  readConnectPairingRequiredMessage,
  readPairingConnectErrorDetails,
  type ConnectPairingRequiredReason,
} from "../gateway/protocol/connect-error-details.js";
import { type RuntimeEnv } from "../runtime.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { buildStatusOverviewSurfaceFromScan } from "./status-overview-surface.ts";
import {
  loadStatusProviderUsageModule,
  resolveStatusGatewayHealth,
  resolveStatusSecurityAudit,
  resolveStatusRuntimeSnapshot,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";
import { buildStatusCommandReportData } from "./status.command-report-data.ts";
import { buildStatusCommandReportLines } from "./status.command-report.ts";
import { logGatewayConnectionDetails } from "./status.gateway-connection.ts";

let statusScanModulePromise: Promise<typeof import("./status.scan.js")> | undefined;
let statusScanFastJsonModulePromise:
  | Promise<typeof import("./status.scan.fast-json.js")>
  | undefined;
let statusAllModulePromise: Promise<typeof import("./status-all.js")> | undefined;
let statusCommandTextRuntimePromise:
  | Promise<typeof import("./status.command.text-runtime.js")>
  | undefined;
let statusGatewayConnectionRuntimePromise:
  | Promise<typeof import("./status.gateway-connection.runtime.js")>
  | undefined;
let statusNodeModeModulePromise: Promise<typeof import("./status.node-mode.js")> | undefined;

function loadStatusScanModule() {
  statusScanModulePromise ??= import("./status.scan.js");
  return statusScanModulePromise;
}

function loadStatusScanFastJsonModule() {
  statusScanFastJsonModulePromise ??= import("./status.scan.fast-json.js");
  return statusScanFastJsonModulePromise;
}

function loadStatusAllModule() {
  statusAllModulePromise ??= import("./status-all.js");
  return statusAllModulePromise;
}

function loadStatusCommandTextRuntime() {
  statusCommandTextRuntimePromise ??= import("./status.command.text-runtime.js");
  return statusCommandTextRuntimePromise;
}

function loadStatusGatewayConnectionRuntime() {
  statusGatewayConnectionRuntimePromise ??= import("./status.gateway-connection.runtime.js");
  return statusGatewayConnectionRuntimePromise;
}

function loadStatusNodeModeModule() {
  statusNodeModeModulePromise ??= import("./status.node-mode.js");
  return statusNodeModeModulePromise;
}

export function resolvePairingRecoveryContext(params: {
  error?: string | null;
  closeReason?: string | null;
  details?: unknown;
}): {
  requestId: string | null;
  reason: ConnectPairingRequiredReason | null;
  remediationHint: string | null;
} | null {
  const structured = readPairingConnectErrorDetails(params.details);
  if (structured) {
    return {
      requestId: normalizePairingConnectRequestId(structured.requestId) ?? null,
      reason: structured.reason ?? null,
      remediationHint: structured.remediationHint
        ? sanitizeTerminalText(structured.remediationHint)
        : null,
    };
  }
  const source = [params.error, params.closeReason]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  const pairing = readConnectPairingRequiredMessage(source);
  if (!pairing) {
    return null;
  }
  return {
    requestId: normalizePairingConnectRequestId(pairing.requestId) ?? null,
    reason: pairing.reason ?? null,
    remediationHint: null,
  };
}

export async function statusCommand(
  opts: {
    json?: boolean;
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  if (opts.all && !opts.json) {
    await loadStatusAllModule().then(({ statusAllCommand }) =>
      statusAllCommand(runtime, { timeoutMs: opts.timeoutMs }),
    );
    return;
  }

  if (opts.json) {
    await runStatusJsonCommand({
      opts,
      runtime,
      includeSecurityAudit: opts.all === true,
      includePluginCompatibility: true,
      suppressHealthErrors: true,
      scanStatusJsonFast: async (scanOpts, runtimeForScan) =>
        await loadStatusScanFastJsonModule().then(({ scanStatusJsonFast }) =>
          scanStatusJsonFast(scanOpts, runtimeForScan),
        ),
    });
    return;
  }

  const scan = await loadStatusScanModule().then(({ scanStatus }) =>
    scanStatus({ json: false, timeoutMs: opts.timeoutMs, all: opts.all }, runtime),
  );

  const {
    cfg,
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
    secretDiagnostics,
    memory,
    memoryPlugin,
    pluginCompatibility,
  } = scan;

  const {
    securityAudit,
    usage,
    health,
    lastHeartbeat,
    gatewayService: daemon,
    nodeService: nodeDaemon,
  } = await resolveStatusRuntimeSnapshot({
    config: scan.cfg,
    sourceConfig: scan.sourceConfig,
    timeoutMs: opts.timeoutMs,
    usage: opts.usage,
    deep: opts.deep,
    gatewayReachable,
    includeSecurityAudit: opts.all === true || opts.deep === true,
    resolveSecurityAudit: async (input) =>
      await withProgress(
        {
          label: "Running security audit…",
          indeterminate: true,
          enabled: true,
        },
        async () => await resolveStatusSecurityAudit(input),
      ),
    resolveUsage: async (timeoutMs) =>
      await withProgress(
        {
          label: "Fetching usage snapshot…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => await resolveStatusUsageSummary(timeoutMs),
      ),
    resolveHealth: async (input) =>
      await withProgress(
        {
          label: "Checking gateway health…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => await resolveStatusGatewayHealth(input),
      ),
  });

  const rich = true;
  const {
    buildStatusUpdateSurface,
    formatCliCommand,
    formatHealthChannelLines,
    formatKTokens,
    formatPromptCacheCompact,
    formatPluginCompatibilityNotice,
    formatTimeAgo,
    formatTokensCompact,
    formatUpdateAvailableHint,
    getTerminalTableWidth,
    info,
    renderTable,
    resolveMemoryCacheSummary,
    resolveMemoryFtsState,
    resolveMemoryVectorState,
    shortenText,
    theme,
  } = await loadStatusCommandTextRuntime();
  const muted = (value: string) => (rich ? theme.muted(value) : value);
  const ok = (value: string) => (rich ? theme.success(value) : value);
  const warn = (value: string) => (rich ? theme.warn(value) : value);
  const updateSurface = buildStatusUpdateSurface({
    updateConfigChannel: cfg.update?.channel,
    update,
  });

  if (opts.verbose) {
    const { buildGatewayConnectionDetails } = await loadStatusGatewayConnectionRuntime();
    const details = buildGatewayConnectionDetails({ config: scan.cfg });
    logGatewayConnectionDetails({
      runtime,
      info,
      message: details.message,
      trailingBlankLine: true,
    });
  }

  const tableWidth = getTerminalTableWidth();

  if (secretDiagnostics.length > 0) {
    runtime.log(theme.warn("Secret diagnostics:"));
    for (const entry of secretDiagnostics) {
      runtime.log(`- ${entry}`);
    }
    runtime.log("");
  }

  const nodeOnlyGateway = await loadStatusNodeModeModule().then(({ resolveNodeOnlyGatewayInfo }) =>
    resolveNodeOnlyGatewayInfo({
      daemon,
      node: nodeDaemon,
    }),
  );
  const pairingRecovery = resolvePairingRecoveryContext({
    error: gatewayProbe?.error ?? null,
    closeReason: gatewayProbe?.close?.reason ?? null,
    details: gatewayProbe?.connectErrorDetails,
  });

  const usageLines = usage
    ? await loadStatusProviderUsageModule().then(({ formatUsageReportLines }) =>
        formatUsageReportLines(usage),
      )
    : undefined;
  const overviewSurface = buildStatusOverviewSurfaceFromScan({
    scan: {
      cfg,
      update,
      tailscaleMode,
      tailscaleDns,
      tailscaleHttpsUrl,
      gatewayMode,
      remoteUrlMissing,
      gatewayConnection,
      gatewayReachable,
      gatewayProbe,
      gatewayProbeAuth,
      gatewayProbeAuthWarning,
      gatewaySelf,
    },
    gatewayService: daemon,
    nodeService: nodeDaemon,
    nodeOnlyGateway,
  });
  const lines = await buildStatusCommandReportLines(
    await buildStatusCommandReportData({
      opts,
      surface: overviewSurface,
      osSummary,
      summary,
      securityAudit,
      health,
      usageLines,
      lastHeartbeat,
      agentStatus,
      channels,
      channelIssues,
      memory,
      memoryPlugin,
      pluginCompatibility,
      pairingRecovery,
      tableWidth,
      ok,
      warn,
      muted,
      shortenText,
      formatCliCommand,
      formatTimeAgo,
      formatKTokens,
      formatTokensCompact,
      formatPromptCacheCompact,
      formatHealthChannelLines,
      formatPluginCompatibilityNotice,
      formatUpdateAvailableHint,
      resolveMemoryVectorState,
      resolveMemoryFtsState,
      resolveMemoryCacheSummary,
      accentDim: theme.accentDim,
      theme,
      renderTable,
      updateValue: updateSurface.updateAvailable
        ? warn(`available · ${updateSurface.updateLine}`)
        : updateSurface.updateLine,
    }),
  );
  for (const line of lines) {
    runtime.log(line);
  }
}
