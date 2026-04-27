import { resolveStatusSummaryFromOverview } from "./status.scan-overview.ts";
import { buildStatusScanResult } from "./status.scan-result.ts";
import { resolveMemoryPluginStatus, } from "./status.scan.shared.js";
export async function executeStatusScanFromOverview(params) {
    const memoryPlugin = resolveMemoryPluginStatus(params.overview.cfg);
    const [memory, summary] = await Promise.all([
        params.resolveMemory({
            cfg: params.overview.cfg,
            agentStatus: params.overview.agentStatus,
            memoryPlugin,
            ...(params.runtime ? { runtime: params.runtime } : {}),
        }),
        resolveStatusSummaryFromOverview({
            overview: params.overview,
            includeChannelSummary: params.summary?.includeChannelSummary,
        }),
    ]);
    return buildStatusScanResult({
        cfg: params.overview.cfg,
        sourceConfig: params.overview.sourceConfig,
        secretDiagnostics: params.overview.secretDiagnostics,
        osSummary: params.overview.osSummary,
        tailscaleMode: params.overview.tailscaleMode,
        tailscaleDns: params.overview.tailscaleDns,
        tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
        update: params.overview.update,
        gatewaySnapshot: params.overview.gatewaySnapshot,
        channelIssues: params.channelIssues,
        agentStatus: params.overview.agentStatus,
        channels: params.channels,
        summary,
        memory,
        memoryPlugin,
        pluginCompatibility: params.pluginCompatibility,
    });
}
