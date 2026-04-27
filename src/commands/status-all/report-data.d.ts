import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { inspectPortUsage } from "../../infra/ports.js";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import { buildPluginCompatibilityNotices } from "../../plugins/status.js";
import { type resolveStatusServiceSummaries } from "../status-runtime-shared.ts";
import type { NodeOnlyGatewayInfo } from "../status.node-mode.js";
import type { StatusScanOverviewResult } from "../status.scan-overview.ts";
type StatusServiceSummaries = Awaited<ReturnType<typeof resolveStatusServiceSummaries>>;
type StatusGatewayServiceSummary = StatusServiceSummaries[0];
type StatusNodeServiceSummary = StatusServiceSummaries[1];
type ConfigFileSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;
type StatusAllProgress = {
    setLabel(label: string): void;
    tick(): void;
};
export declare function buildStatusAllReportData(params: {
    overview: StatusScanOverviewResult;
    daemon: StatusGatewayServiceSummary;
    nodeService: StatusNodeServiceSummary;
    nodeOnlyGateway: NodeOnlyGatewayInfo | null;
    progress: StatusAllProgress;
    timeoutMs?: number;
}): Promise<{
    overviewRows: import("./format.js").StatusOverviewRow[];
    channels: {
        rows: import("./channels.js").ChannelRow[];
        details: Array<{
            title: string;
            columns: string[];
            rows: Array<Record<string, string>>;
        }>;
    };
    channelIssues: {
        channel: import("../../plugin-sdk/index.js").ChannelId;
        message: string;
    }[];
    agentStatus: {
        defaultId: string;
        agents: import("../status.agent-local.js").AgentLocalStatus[];
        totalSessions: number;
        bootstrapPendingCount: number;
    };
    connectionDetailsForReport: string;
    diagnosis: {
        health: import("../health.types.js").HealthSummary | {
            error: string;
        } | undefined;
        snap: ConfigFileSnapshot | null;
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
        nodeOnlyGateway: NodeOnlyGatewayInfo | null;
    };
}>;
export {};
