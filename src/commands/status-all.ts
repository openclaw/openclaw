import { canExecRequestNode } from "../agents/exec-defaults.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { formatCliCommand } from "../cli/command-format.js";
import { withProgress } from "../cli/progress.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import { inspectPortUsage } from "../infra/ports.js";
import { readRestartSentinel } from "../infra/restart-sentinel.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { buildPluginCompatibilityNotices } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { VERSION } from "../version.js";
import {
  buildStatusGatewaySurfaceValues,
  buildStatusOverviewRows,
  buildStatusUpdateSurface,
  formatStatusDashboardValue,
  formatStatusTailscaleValue,
} from "./status-all/format.js";
import { buildStatusAllReportLines } from "./status-all/report-lines.js";
import {
  resolveStatusGatewayHealthSafe,
  resolveStatusServiceSummaries,
} from "./status-runtime-shared.ts";
import { resolveNodeOnlyGatewayInfo } from "./status.node-mode.js";
import { collectStatusScanOverview } from "./status.scan-overview.ts";

export async function statusAllCommand(
  runtime: RuntimeEnv,
  opts?: { timeoutMs?: number },
): Promise<void> {
  await withProgress({ label: "Scanning status --all…", total: 11 }, async (progress) => {
    const overview = await collectStatusScanOverview({
      commandName: "status --all",
      opts: {
        timeoutMs: opts?.timeoutMs,
      },
      showSecrets: false,
      runtime,
      useGatewayCallOverridesForChannelsStatus: true,
      progress,
      labels: {
        loadingConfig: "Loading config…",
        checkingTailscale: "Checking Tailscale…",
        checkingForUpdates: "Checking for updates…",
        resolvingAgents: "Scanning agents…",
        probingGateway: "Probing gateway…",
        queryingChannelStatus: "Querying gateway…",
        summarizingChannels: "Summarizing channels…",
      },
    });
    const cfg = overview.cfg;
    const secretDiagnostics = overview.secretDiagnostics;
    const osSummary = overview.osSummary;
    const snap = await readConfigFileSnapshot().catch(() => null);
    const tailscaleMode = overview.tailscaleMode;
    const tailscaleHttpsUrl = overview.tailscaleHttpsUrl;
    const update = overview.update;
    const updateSurface = buildStatusUpdateSurface({
      updateConfigChannel: cfg.update?.channel,
      update,
    });
    const channelLabel = updateSurface.channelLabel;
    const gitLabel = updateSurface.gitLabel;
    const tailscale = {
      backendState: null,
      dnsName: overview.tailscaleDns,
      ips: [] as string[],
      error: null,
    };
    const {
      gatewayConnection: connection,
      gatewayMode,
      remoteUrlMissing,
      gatewayProbeAuth: probeAuth,
      gatewayProbeAuthWarning,
      gatewayProbe,
      gatewayReachable,
      gatewaySelf,
      gatewayCallOverrides,
    } = overview.gatewaySnapshot;

    progress.setLabel("Checking services…");
    const [daemon, nodeService] = await resolveStatusServiceSummaries();
    const nodeOnlyGateway = await resolveNodeOnlyGatewayInfo({
      daemon,
      node: nodeService,
    });
    progress.tick();
    const agentStatus = overview.agentStatus;
    const channels = overview.channels;

    const connectionDetailsForReport = (() => {
      if (nodeOnlyGateway) {
        return nodeOnlyGateway.connectionDetails;
      }
      if (!remoteUrlMissing) {
        return connection.message;
      }
      const bindMode = cfg.gateway?.bind ?? "loopback";
      const configPath = snap?.path?.trim() ? snap.path.trim() : "(unknown config path)";
      return [
        "Gateway mode: remote",
        "Gateway target: (missing gateway.remote.url)",
        `Config: ${configPath}`,
        `Bind: ${bindMode}`,
        `Local fallback (used for probes): ${connection.url}`,
        "Fix: set gateway.remote.url, or set gateway.mode=local.",
      ].join("\n");
    })();

    const callOverrides = gatewayCallOverrides ?? {};

    const health = nodeOnlyGateway
      ? undefined
      : await resolveStatusGatewayHealthSafe({
          config: cfg,
          timeoutMs: Math.min(8000, opts?.timeoutMs ?? 10_000),
          gatewayReachable,
          gatewayProbeError: gatewayProbe?.error ?? null,
          callOverrides,
        });
    const channelsStatus = overview.channelsStatus;
    const channelIssues = overview.channelIssues;

    progress.setLabel("Checking local state…");
    const sentinel = await readRestartSentinel().catch(() => null);
    const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
    const port = resolveGatewayPort(cfg);
    const portUsage = await inspectPortUsage(port).catch(() => null);
    progress.tick();

    const defaultWorkspace =
      agentStatus.agents.find((a) => a.id === agentStatus.defaultId)?.workspaceDir ??
      agentStatus.agents[0]?.workspaceDir ??
      null;
    const skillStatus =
      defaultWorkspace != null
        ? (() => {
            try {
              return buildWorkspaceSkillStatus(defaultWorkspace, {
                config: cfg,
                eligibility: {
                  remote: getRemoteSkillEligibility({
                    advertiseExecNode: canExecRequestNode({
                      cfg,
                      agentId: agentStatus.defaultId,
                    }),
                  }),
                },
              });
            } catch {
              return null;
            }
          })()
        : null;
    const pluginCompatibility = buildPluginCompatibilityNotices({ config: cfg });

    const { dashboardUrl, gatewayValue, gatewaySelfValue, gatewayServiceValue, nodeServiceValue } =
      buildStatusGatewaySurfaceValues({
        cfg,
        gatewayMode,
        remoteUrlMissing,
        gatewayConnection: connection,
        gatewayReachable,
        gatewayProbe,
        gatewayProbeAuth: probeAuth,
        gatewaySelf,
        gatewayService: daemon,
        nodeService,
        nodeOnlyGateway,
      });

    const aliveThresholdMs = 10 * 60_000;
    const aliveAgents = agentStatus.agents.filter(
      (a) => a.lastActiveAgeMs != null && a.lastActiveAgeMs <= aliveThresholdMs,
    ).length;

    const overviewRows = buildStatusOverviewRows({
      prefixRows: [
        { Item: "Version", Value: VERSION },
        { Item: "OS", Value: osSummary.label },
        { Item: "Node", Value: process.versions.node },
        {
          Item: "Config",
          Value: snap?.path?.trim() ? snap.path.trim() : "(unknown config path)",
        },
      ],
      dashboardValue: formatStatusDashboardValue(dashboardUrl),
      tailscaleValue: formatStatusTailscaleValue({
        tailscaleMode,
        dnsName: tailscale.dnsName,
        httpsUrl: tailscaleHttpsUrl,
        backendState: tailscale.backendState,
        includeBackendStateWhenOff: true,
        includeBackendStateWhenOn: true,
        includeDnsNameWhenOff: true,
      }),
      channelLabel,
      gitLabel,
      updateValue: updateSurface.updateLine,
      gatewayValue,
      gatewayAuthWarning: gatewayProbeAuthWarning,
      middleRows: [
        { Item: "Security", Value: `Run: ${formatCliCommand("openclaw security audit --deep")}` },
      ],
      gatewaySelfValue: gatewaySelfValue ?? "unknown",
      gatewayServiceValue,
      nodeServiceValue,
      agentsValue: `${agentStatus.agents.length} total · ${agentStatus.bootstrapPendingCount} bootstrapping · ${aliveAgents} active · ${agentStatus.totalSessions} sessions`,
      suffixRows: [
        {
          Item: "Secrets",
          Value:
            secretDiagnostics.length > 0
              ? `${secretDiagnostics.length} diagnostic${secretDiagnostics.length === 1 ? "" : "s"}`
              : "none",
        },
      ],
    });

    const lines = await buildStatusAllReportLines({
      progress,
      overviewRows,
      channels,
      channelIssues: channelIssues.map((issue) => ({
        channel: issue.channel,
        message: issue.message,
      })),
      agentStatus,
      connectionDetailsForReport,
      diagnosis: {
        snap,
        remoteUrlMissing,
        secretDiagnostics,
        sentinel,
        lastErr,
        port,
        portUsage,
        tailscaleMode,
        tailscale,
        tailscaleHttpsUrl,
        skillStatus,
        pluginCompatibility,
        channelsStatus,
        channelIssues,
        gatewayReachable,
        health,
        nodeOnlyGateway,
      },
    });

    progress.setLabel("Rendering…");
    runtime.log(lines.join("\n"));
    progress.tick();
  });
}
