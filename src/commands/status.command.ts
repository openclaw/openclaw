// Main `openclaw status` command orchestrator.
// It routes all/json/deep modes, collects scan/runtime state, and delegates formatting to report builders.

import {
  normalizePairingConnectRequestId,
  readConnectPairingRequiredMessage,
  readPairingConnectErrorDetails,
  type ConnectPairingRequiredReason,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { withProgress } from "../cli/progress.js";
import { OPENCLAW_WRAPPER_ENV_KEY } from "../daemon/program-args.js";
import { readRestartSentinelReadOnly } from "../infra/restart-sentinel.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { collectNodeRuntimeFindings } from "./node-runtime-diagnostics.js";
import { assertStatusUsageAgentScope, runStatusJsonCommand } from "./status-json-command.ts";
import { buildStatusOverviewSurfaceFromScan } from "./status-overview-surface.ts";
import {
  reportStatusScanFailure,
  resolveStatusGatewayHealth,
  resolveStatusSecurityAudit,
  resolveStatusRuntimeSnapshot,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";
import { buildStatusUpdateRows } from "./status-update-restart.ts";
import { logGatewayConnectionDetails } from "./status.gateway-connection.ts";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";

const statusScanModuleLoader = createLazyImportLoader(() => import("./status.scan.js"));
const statusScanFastJsonModuleLoader = createLazyImportLoader(
  () => import("./status.scan.fast-json.js"),
);
const statusAllModuleLoader = createLazyImportLoader(() => import("./status-all.js"));
const statusCommandTextRuntimeLoader = createLazyImportLoader(
  () => import("./status.command.text-runtime.js"),
);
const statusNodeModeModuleLoader = createLazyImportLoader(() => import("./status.node-mode.js"));

/** Extracts device-pairing recovery context from structured gateway errors or legacy message text. */
function resolvePairingRecoveryContext(params: {
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
  // Older gateways only exposed pairing details in close/error text; keep status recovery helpful there.
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

function resolveServiceWrapperContextHint(params: {
  serviceWrapperPath?: string | null;
  cliWrapperPath?: string | null;
}): string | null {
  const serviceWrapperPath = params.serviceWrapperPath?.trim();
  if (!serviceWrapperPath) {
    return null;
  }
  if (params.cliWrapperPath?.trim() === serviceWrapperPath) {
    return null;
  }
  return `The installed gateway service uses ${OPENCLAW_WRAPPER_ENV_KEY} (${sanitizeTerminalText(serviceWrapperPath)}), but this CLI process is not running with that same wrapper. Missing-secret diagnostics may describe the current CLI process rather than the installed gateway service context.`;
}

/** Runs `openclaw status`, including JSON/all routing and optional deep probes. */
export async function statusCommand(
  opts: {
    json?: boolean;
    deep?: boolean;
    usage?: boolean;
    agent?: string;
    timeoutMs?: number;
    verbose?: boolean;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const probeBudget = createStatusGatewayProbeBudget(opts.timeoutMs);
  assertStatusUsageAgentScope(opts);
  for (const finding of await collectNodeRuntimeFindings()) {
    const write = opts.json ? runtime.error : runtime.log;
    write(
      `[${finding.severity}] ${finding.message}${finding.fixHint ? `\n${finding.fixHint}` : ""}`,
    );
  }
  if (opts.all && !opts.json) {
    // Human `--all` has a dedicated report path; JSON `--all` stays on the JSON schema.
    await statusAllModuleLoader
      .load()
      .then(({ statusAllCommand }) => statusAllCommand(runtime, { ...opts, ...probeBudget }));
    return;
  }

  if (opts.json) {
    await runStatusJsonCommand({
      opts: { ...opts, ...probeBudget },
      runtime,
      includeSecurityAudit: opts.all === true || opts.deep === true,
      includePluginCompatibility: opts.all === true,
      suppressHealthErrors: true,
      scanStatusJsonFast: async (scanOpts, runtimeForScan) =>
        await statusScanFastJsonModuleLoader
          .load()
          .then(({ scanStatusJsonFast }) => scanStatusJsonFast(scanOpts, runtimeForScan)),
    });
    return;
  }

  const scan = await statusScanModuleLoader
    .load()
    .then(({ scanStatus }) => scanStatus({ ...probeBudget, deep: opts.deep }))
    .catch((error: unknown) => reportStatusScanFailure(error, runtime, opts.timeoutMs));

  const {
    cfg,
    osSummary,
    update,
    gatewayProbe,
    gatewayReachable,
    channelIssues,
    agentStatus,
    channels,
    summary,
    configDiagnostics,
    secretDiagnostics,
    memory,
    memoryPlugin,
    pluginCompatibility,
    env,
  } = scan;

  if (configDiagnostics) {
    const { formatStatusConfigDiagnosticEntries, theme } =
      await statusCommandTextRuntimeLoader.load();
    runtime.log(theme.warn("Config diagnostics:"));
    for (const entry of formatStatusConfigDiagnosticEntries(configDiagnostics)) {
      runtime.log(entry);
    }
    runtime.log("");
  }

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
    ...probeBudget,
    ...(opts.agent ? { agentId: opts.agent } : {}),
    usage: opts.usage,
    deep: opts.deep,
    gatewayReachable,
    ...(gatewayProbe?.startupPhase ? { gatewayStartupPhase: gatewayProbe.startupPhase } : {}),
    ...(gatewayProbe?.error ? { gatewayProbeError: gatewayProbe.error } : {}),
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
    resolveUsage: async (input) =>
      await withProgress(
        {
          label: "Fetching usage snapshot…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => await resolveStatusUsageSummary(input),
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

  // Structured probe failures belong to nonthrowing JSON; text status keeps failures loud.
  if (health && "error" in health) {
    throw new Error(health.error);
  }

  const {
    buildStatusCommandReportData,
    buildStatusCommandReportLines,
    buildStatusUpdateSurface,
    formatUsageReportLines,
    getTerminalTableWidth,
    info,
    theme,
  } = await statusCommandTextRuntimeLoader.load();
  const { muted, success: ok, warn } = theme;
  const updateSurface = buildStatusUpdateSurface({
    updateConfigChannel: cfg.update?.channel,
    update,
  });

  if (opts.verbose) {
    // Verbose status prints the raw gateway target resolution before the report tables.
    const { buildGatewayConnectionDetails } = await import("../gateway/call.js");
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
    // Secret diagnostics are already redacted by the scanner; show them before the main report.
    runtime.log(theme.warn("Secret diagnostics:"));
    for (const entry of secretDiagnostics) {
      runtime.log(`- ${entry}`);
    }
    const wrapperContextHint = resolveServiceWrapperContextHint({
      serviceWrapperPath: daemon.wrapperPath,
      cliWrapperPath: process.env[OPENCLAW_WRAPPER_ENV_KEY],
    });
    if (wrapperContextHint) {
      runtime.log(theme.warn(wrapperContextHint));
    }
    runtime.log("");
  }

  const nodeOnlyGateway = await statusNodeModeModuleLoader
    .load()
    .then(({ resolveNodeOnlyGatewayInfo }) =>
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

  const usageLines = usage ? formatUsageReportLines(usage) : undefined;
  const overviewSurface = buildStatusOverviewSurfaceFromScan({
    scan,
    gatewayService: daemon,
    nodeService: nodeDaemon,
    nodeOnlyGateway,
  });
  const updateRows = buildStatusUpdateRows(
    (await readRestartSentinelReadOnly().catch(() => null))?.payload,
    {
      ok,
      warn,
      muted,
    },
  );
  const lines = await buildStatusCommandReportLines(
    await buildStatusCommandReportData({
      env: env ?? {},
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
      updateValue: updateSurface.updateAvailable
        ? warn(`available · ${updateSurface.updateLine}`)
        : updateSurface.updateLine,
      updateRows,
    }),
  );
  runtime.log(lines.join("\n"));
}
