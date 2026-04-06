import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../../config/config.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import { inspectPortUsage } from "../../infra/ports.js";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { buildPluginCompatibilityNotices } from "../../plugins/status.js";
import { VERSION } from "../../version.js";
import { buildStatusAllAgentsValue, buildStatusSecretsValue } from "../status-overview-values.ts";
import {
  resolveStatusGatewayHealthSafe,
  type resolveStatusServiceSummaries,
} from "../status-runtime-shared.ts";
import { resolveStatusAllConnectionDetails } from "../status.gateway-connection.ts";
import type { NodeOnlyGatewayInfo } from "../status.node-mode.js";
import type { StatusScanOverviewResult } from "../status.scan-overview.ts";
import { buildStatusOverviewSurfaceRows } from "./format.js";

type StatusServiceSummaries = Awaited<ReturnType<typeof resolveStatusServiceSummaries>>;
type StatusGatewayServiceSummary = StatusServiceSummaries[0];
type StatusNodeServiceSummary = StatusServiceSummaries[1];
type StatusGatewayHealthSafe = Awaited<ReturnType<typeof resolveStatusGatewayHealthSafe>>;

type StatusAllProgress = {
  setLabel(label: string): void;
  tick(): void;
};

function resolveStatusAllConfigPath(path: string | null | undefined): string {
  const trimmed = path?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "(unknown config path)";
}

async function resolveStatusAllLocalDiagnosis(params: {
  overview: StatusScanOverviewResult;
  progress: StatusAllProgress;
  gatewayReachable: boolean;
  gatewayProbe: StatusScanOverviewResult["gatewaySnapshot"]["gatewayProbe"];
  gatewayCallOverrides: StatusScanOverviewResult["gatewaySnapshot"]["gatewayCallOverrides"];
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  timeoutMs?: number;
}): Promise<{
  configPath: string;
  health: StatusGatewayHealthSafe | undefined;
  diagnosis: {
    snap: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
    remoteUrlMissing: boolean;
    secretDiagnostics: StatusScanOverviewResult["secretDiagnostics"];
    sentinel: Awaited<ReturnType<typeof readRestartSentinel>> | null;
    lastErr: string | null;
    port: number;
    portUsage: Awaited<ReturnType<typeof inspectPortUsage>> | null;
    tailscaleMode: string;
    tailscale: {
      backendState: null;
      dnsName: string | null;
      ips: string[];
      error: null;
    };
    tailscaleHttpsUrl: string | null;
    skillStatus: ReturnType<typeof buildWorkspaceSkillStatus> | null;
    pluginCompatibility: ReturnType<typeof buildPluginCompatibilityNotices>;
    channelsStatus: StatusScanOverviewResult["channelsStatus"];
    channelIssues: StatusScanOverviewResult["channelIssues"];
    gatewayReachable: boolean;
    health: StatusGatewayHealthSafe | undefined;
    nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  };
}> {
  const { overview } = params;
  const snap = await readConfigFileSnapshot().catch(() => null);
  const configPath = resolveStatusAllConfigPath(snap?.path);

  const health = params.nodeOnlyGateway
    ? undefined
    : await resolveStatusGatewayHealthSafe({
        config: overview.cfg,
        timeoutMs: Math.min(8000, params.timeoutMs ?? 10_000),
        gatewayReachable: params.gatewayReachable,
        gatewayProbeError: params.gatewayProbe?.error ?? null,
        callOverrides: params.gatewayCallOverrides ?? {},
      });

  params.progress.setLabel("Checking local state…");
  const sentinel = await readRestartSentinel().catch(() => null);
  const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
  const port = resolveGatewayPort(overview.cfg);
  const portUsage = await inspectPortUsage(port).catch(() => null);
  params.progress.tick();

  const defaultWorkspace =
    overview.agentStatus.agents.find((a) => a.id === overview.agentStatus.defaultId)
      ?.workspaceDir ??
    overview.agentStatus.agents[0]?.workspaceDir ??
    null;
  const skillStatus =
    defaultWorkspace != null
      ? (() => {
          try {
            return buildWorkspaceSkillStatus(defaultWorkspace, {
              config: overview.cfg,
              eligibility: {
                remote: getRemoteSkillEligibility({
                  advertiseExecNode: canExecRequestNode({
                    cfg: overview.cfg,
                    agentId: overview.agentStatus.defaultId,
                  }),
                }),
              },
            });
          } catch {
            return null;
          }
        })()
      : null;
  const pluginCompatibility = buildPluginCompatibilityNotices({ config: overview.cfg });

  return {
    configPath,
    health,
    diagnosis: {
      snap,
      remoteUrlMissing: overview.gatewaySnapshot.remoteUrlMissing,
      secretDiagnostics: overview.secretDiagnostics,
      sentinel,
      lastErr,
      port,
      portUsage,
      tailscaleMode: overview.tailscaleMode,
      tailscale: {
        backendState: null,
        dnsName: overview.tailscaleDns,
        ips: [],
        error: null,
      },
      tailscaleHttpsUrl: overview.tailscaleHttpsUrl,
      skillStatus,
      pluginCompatibility,
      channelsStatus: overview.channelsStatus,
      channelIssues: overview.channelIssues,
      gatewayReachable: params.gatewayReachable,
      health,
      nodeOnlyGateway: params.nodeOnlyGateway,
    },
  };
}

export async function buildStatusAllReportData(params: {
  overview: StatusScanOverviewResult;
  daemon: StatusGatewayServiceSummary;
  nodeService: StatusNodeServiceSummary;
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  progress: StatusAllProgress;
  timeoutMs?: number;
}) {
  const gatewaySnapshot = params.overview.gatewaySnapshot;
  const { configPath, health, diagnosis } = await resolveStatusAllLocalDiagnosis({
    overview: params.overview,
    progress: params.progress,
    gatewayReachable: gatewaySnapshot.gatewayReachable,
    gatewayProbe: gatewaySnapshot.gatewayProbe,
    gatewayCallOverrides: gatewaySnapshot.gatewayCallOverrides,
    nodeOnlyGateway: params.nodeOnlyGateway,
    timeoutMs: params.timeoutMs,
  });

  const overviewRows = buildStatusOverviewSurfaceRows({
    cfg: params.overview.cfg,
    update: params.overview.update,
    tailscaleMode: params.overview.tailscaleMode,
    tailscaleDns: params.overview.tailscaleDns,
    tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
    tailscaleBackendState: diagnosis.tailscale.backendState,
    includeBackendStateWhenOff: true,
    includeBackendStateWhenOn: true,
    includeDnsNameWhenOff: true,
    gatewayMode: gatewaySnapshot.gatewayMode,
    remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
    gatewayConnection: gatewaySnapshot.gatewayConnection,
    gatewayReachable: gatewaySnapshot.gatewayReachable,
    gatewayProbe: gatewaySnapshot.gatewayProbe,
    gatewayProbeAuth: gatewaySnapshot.gatewayProbeAuth,
    gatewayProbeAuthWarning: gatewaySnapshot.gatewayProbeAuthWarning,
    gatewaySelf: gatewaySnapshot.gatewaySelf,
    gatewayService: params.daemon,
    nodeService: params.nodeService,
    nodeOnlyGateway: params.nodeOnlyGateway,
    prefixRows: [
      { Item: "Version", Value: VERSION },
      { Item: "OS", Value: params.overview.osSummary.label },
      { Item: "Node", Value: process.versions.node },
      { Item: "Config", Value: configPath },
    ],
    middleRows: [
      { Item: "Security", Value: `Run: ${formatCliCommand("openclaw security audit --deep")}` },
    ],
    agentsValue: buildStatusAllAgentsValue({
      agentStatus: params.overview.agentStatus,
    }),
    suffixRows: [
      {
        Item: "Secrets",
        Value: buildStatusSecretsValue(params.overview.secretDiagnostics.length),
      },
    ],
    gatewaySelfFallbackValue: "unknown",
  });

  return {
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
    diagnosis: {
      ...diagnosis,
      health,
    },
  };
}
