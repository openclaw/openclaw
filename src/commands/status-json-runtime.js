import { buildStatusJsonPayload } from "./status-json-payload.ts";
import { buildStatusOverviewSurfaceFromScan } from "./status-overview-surface.ts";
import { resolveStatusRuntimeSnapshot } from "./status-runtime-shared.ts";
export async function resolveStatusJsonOutput(params) {
    const { scan, opts } = params;
    const { securityAudit, usage, health, lastHeartbeat, gatewayService, nodeService } = await resolveStatusRuntimeSnapshot({
        config: scan.cfg,
        sourceConfig: scan.sourceConfig,
        timeoutMs: opts.timeoutMs,
        usage: opts.usage,
        deep: opts.deep,
        gatewayReachable: scan.gatewayReachable,
        includeSecurityAudit: params.includeSecurityAudit,
        suppressHealthErrors: params.suppressHealthErrors,
    });
    return buildStatusJsonPayload({
        summary: scan.summary,
        surface: buildStatusOverviewSurfaceFromScan({
            scan: scan,
            gatewayService,
            nodeService,
        }),
        osSummary: scan.osSummary,
        memory: scan.memory,
        memoryPlugin: scan.memoryPlugin,
        agents: scan.agentStatus,
        secretDiagnostics: scan.secretDiagnostics,
        securityAudit,
        health,
        usage,
        lastHeartbeat,
        pluginCompatibility: params.includePluginCompatibility ? scan.pluginCompatibility : undefined,
    });
}
