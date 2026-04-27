import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../../config/config.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import { inspectPortUsage } from "../../infra/ports.js";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { buildPluginCompatibilityNotices } from "../../plugins/status.js";
import { buildStatusAllOverviewRows } from "../status-overview-rows.ts";
import { buildStatusOverviewSurfaceFromOverview, } from "../status-overview-surface.ts";
import { resolveStatusGatewayHealthSafe, } from "../status-runtime-shared.ts";
import { resolveStatusAllConnectionDetails } from "../status.gateway-connection.ts";
function resolveStatusAllConfigPath(path) {
    const trimmed = path?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : "(unknown config path)";
}
async function resolveStatusAllLocalDiagnosis(params) {
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
            ...(params.gatewayCallOverrides ? { callOverrides: params.gatewayCallOverrides } : {}),
        });
    params.progress.setLabel("Checking local state…");
    const sentinel = await readRestartSentinel().catch(() => null);
    const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
    const port = resolveGatewayPort(overview.cfg);
    const portUsage = await inspectPortUsage(port).catch(() => null);
    params.progress.tick();
    const defaultWorkspace = overview.agentStatus.agents.find((a) => a.id === overview.agentStatus.defaultId)
        ?.workspaceDir ??
        overview.agentStatus.agents[0]?.workspaceDir ??
        null;
    const skillStatus = defaultWorkspace != null
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
            }
            catch {
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
export async function buildStatusAllReportData(params) {
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
    const overviewSurface = buildStatusOverviewSurfaceFromOverview({
        overview: params.overview,
        gatewayService: params.daemon,
        nodeService: params.nodeService,
        nodeOnlyGateway: params.nodeOnlyGateway,
    });
    const overviewRows = buildStatusAllOverviewRows({
        surface: overviewSurface,
        osLabel: params.overview.osSummary.label,
        configPath,
        secretDiagnosticsCount: params.overview.secretDiagnostics.length,
        agentStatus: params.overview.agentStatus,
        tailscaleBackendState: diagnosis.tailscale.backendState,
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
