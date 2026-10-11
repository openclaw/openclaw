// This file performs local read-only probes; formatting stays in report-line builders.

import { resolveNodeExecEligibility } from "../../agents/exec-defaults.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../../config/config.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import { resolveGatewayBindHost, resolveGatewayRequiredListenHosts } from "../../gateway/net.js";
import { loadExecApprovalsReadOnly } from "../../infra/exec-approvals.js";
import { inspectPortUsage } from "../../infra/ports-inspect.js";
import { readRestartSentinelReadOnly } from "../../infra/restart-sentinel.js";
import { resolvePluginControlPlaneWorkspace } from "../../plugins/control-plane-workspace.js";
import {
  buildPluginCompatibilityNotices,
  withPluginDiagnosticsReport,
} from "../../plugins/status.js";
import { buildWorkspaceSkillReadiness } from "../../skills/discovery/status.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { buildStatusAllOverviewRows } from "../status-overview-rows.ts";
import {
  resolveStatusAutomations,
  resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe,
  type resolveStatusServiceSummaries,
} from "../status-runtime-shared.ts";
import { buildStatusUpdateRows } from "../status-update-restart.ts";
import { resolveStatusAllConnectionDetails } from "../status.gateway-connection.ts";
import type { NodeOnlyGatewayInfo } from "../status.node-mode.js";
import {
  resolveStatusSummaryFromOverview,
  type StatusScanOverviewResult,
} from "../status.scan-overview.ts";

type StatusServiceSummaries = Awaited<ReturnType<typeof resolveStatusServiceSummaries>>;

type StatusAllProgress = {
  setLabel(label: string): void;
  tick(): void;
};

async function resolveStatusAllLocalDiagnosis(params: {
  overview: StatusScanOverviewResult;
  progress: StatusAllProgress;
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
}) {
  const { overview } = params;
  const { gatewayReachable, gatewayProbe, gatewayCallOverrides } = overview.gatewaySnapshot;
  const snap = await readConfigFileSnapshot({ observe: false }).catch(() => null);
  const configPath = snap?.path?.trim() || "(unknown config path)";
  const diagnosticsParams = {
    config: overview.cfg,
    gatewayProbeDeadlineMs: params.gatewayProbeDeadlineMs,
    timeoutMs: Math.min(5000, params.timeoutMs ?? 10_000),
    gatewayReachable,
    ...(gatewayCallOverrides ? { callOverrides: gatewayCallOverrides } : {}),
  };

  const [health, deliveryDiagnostics, exporterDiagnostics] =
    params.nodeOnlyGateway || gatewayProbe?.startupPhase
      ? [undefined, null, null]
      : await Promise.all([
          resolveStatusGatewayHealthSafe({
            ...diagnosticsParams,
            timeoutMs: Math.min(8000, params.timeoutMs ?? 10_000),
            gatewayProbeError: gatewayProbe?.error ?? null,
          }),
          resolveStatusGatewayDiagnosticsSafe(diagnosticsParams),
          resolveStatusGatewayDiagnosticsSafe({
            ...diagnosticsParams,
            type: "telemetry.exporter",
          }),
        ]);

  params.progress.setLabel("Checking local state…");
  // These probes are intentionally best-effort so status-all can still print a partial report.
  const sentinel = await readRestartSentinelReadOnly().catch(() => null);
  const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
  const port = resolveGatewayPort(overview.cfg);
  const bindHost = await resolveGatewayBindHost(
    overview.cfg.gateway?.bind ?? "loopback",
    overview.cfg.gateway?.customBindHost,
  );
  const portUsage = await inspectPortUsage(port, {
    probeHosts: resolveGatewayRequiredListenHosts(bindHost),
  }).catch(() => null);
  params.progress.tick();

  const controlPlaneWorkspace = resolvePluginControlPlaneWorkspace({
    config: overview.cfg,
    env: process.env,
  });
  const defaultWorkspace = controlPlaneWorkspace.workspaceDir ?? null;
  let skillReadiness: ReturnType<typeof buildWorkspaceSkillReadiness> | null = null;
  if (defaultWorkspace != null) {
    try {
      // Skill eligibility depends on whether the default agent may request node exec.
      const nodeSkills = resolveNodeExecEligibility({
        cfg: overview.cfg,
        execApprovals: loadExecApprovalsReadOnly(),
        agentId: controlPlaneWorkspace.agentId,
      });
      skillReadiness = buildWorkspaceSkillReadiness(defaultWorkspace, {
        config: overview.cfg,
        agentId: controlPlaneWorkspace.agentId,
        eligibility: {
          nodeSkills,
          remote: getRemoteSkillEligibility({
            advertiseExecNode: nodeSkills.canExec,
          }),
        },
      });
    } catch {
      // Preserve a partial report when local skill inspection fails.
    }
  }
  const pluginCompatibility = await withPluginDiagnosticsReport(
    { config: overview.cfg },
    (report) => buildPluginCompatibilityNotices({ report }),
  );

  return {
    configPath,
    diagnosis: {
      snap,
      remoteUrlMissing: overview.gatewaySnapshot.remoteUrlMissing,
      secretDiagnostics: overview.secretDiagnostics,
      sentinel,
      lastErr,
      port,
      portUsage,
      tailscaleMode: overview.tailscaleMode,
      tailscaleDns: overview.tailscaleDns,
      tailscaleHttpsUrl: overview.tailscaleHttpsUrl,
      skillReadiness,
      pluginCompatibility,
      channelsStatus: overview.channelsStatus,
      channelIssues: overview.channelIssues,
      agentStatus: overview.agentStatus,
      gatewayReachable,
      gatewayStartupPhase: gatewayProbe?.startupPhase,
      localGatewayHealthy:
        overview.gatewaySnapshot.localGatewayHealthy === true && !(health && "error" in health),
      gatewayServer: gatewayProbe?.server,
      health,
      deliveryDiagnostics,
      exporterDiagnostics,
      nodeOnlyGateway: params.nodeOnlyGateway,
    },
  };
}

export async function buildStatusAllReportData(params: {
  overview: StatusScanOverviewResult;
  daemon: StatusServiceSummaries[0];
  nodeService: StatusServiceSummaries[1];
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  progress: StatusAllProgress;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
}) {
  const gatewaySnapshot = params.overview.gatewaySnapshot;
  const [{ configPath, diagnosis }, summary, automations] = await Promise.all([
    resolveStatusAllLocalDiagnosis(params),
    params.overview.runtimeDegradation ??
      resolveStatusSummaryFromOverview({ overview: params.overview }),
    resolveStatusAutomations({
      config: params.overview.cfg,
      gatewayReachable: gatewaySnapshot.gatewayReachable && !params.nodeOnlyGateway,
      gatewayStartupPhase: gatewaySnapshot.gatewayProbe?.startupPhase,
      gatewayProbeDeadlineMs: params.gatewayProbeDeadlineMs,
      timeoutMs: params.timeoutMs,
      ...(gatewaySnapshot.gatewayCallOverrides
        ? { callOverrides: gatewaySnapshot.gatewayCallOverrides }
        : {}),
    }),
  ]);

  const overviewSurface = {
    ...params.overview,
    ...gatewaySnapshot,
    gatewayService: params.daemon,
    nodeService: params.nodeService,
    nodeOnlyGateway: params.nodeOnlyGateway,
  };
  const overviewRows = buildStatusAllOverviewRows({
    automations,
    surface: overviewSurface,
    osLabel: params.overview.osSummary.label,
    configPath,
    summary,
    secretDiagnosticsCount: params.overview.secretDiagnostics.length,
    updateRows: await buildStatusUpdateRows(diagnosis.sentinel?.payload, {
      localGatewayHealthy: diagnosis.localGatewayHealthy,
      gatewayServer: diagnosis.gatewayServer,
    }),
    agentStatus: params.overview.agentStatus,
  });

  return {
    configDiagnostics: params.overview.configDiagnostics,
    overviewRows,
    channels: params.overview.channels,
    channelIssues: params.overview.channelIssues.map((issue) => ({
      channel: issue.channel,
      message: issue.message,
    })),
    agentStatus: params.overview.agentStatus,
    connectionDetailsForReport: resolveStatusAllConnectionDetails({
      nodeOnlyGateway: params.nodeOnlyGateway,
      remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
      gatewayConnection: gatewaySnapshot.gatewayConnection,
      bindMode: params.overview.cfg.gateway?.bind ?? "loopback",
      configPath,
    }),
    diagnosis,
  };
}
