import { formatCliCommand } from "../cli/command-format.js";
import { VERSION } from "../version.js";
import { buildStatusOverviewRowsFromSurface, } from "./status-overview-surface.ts";
import { buildStatusAllAgentsValue, buildStatusEventsValue, buildStatusPluginCompatibilityValue, buildStatusProbesValue, buildStatusSecretsValue, buildStatusSessionsOverviewValue, } from "./status-overview-values.ts";
import { buildStatusAgentsValue, buildStatusHeartbeatValue, buildStatusLastHeartbeatValue, buildStatusMemoryValue, buildStatusTasksValue, } from "./status.command-sections.js";
export function buildStatusCommandOverviewRows(params) {
    const agentsValue = buildStatusAgentsValue({
        agentStatus: params.agentStatus,
        formatTimeAgo: params.formatTimeAgo,
    });
    const eventsValue = buildStatusEventsValue({
        queuedSystemEvents: params.summary.queuedSystemEvents,
    });
    const tasksValue = buildStatusTasksValue({
        summary: params.summary,
        warn: params.warn,
        muted: params.muted,
    });
    const probesValue = buildStatusProbesValue({
        health: params.health,
        ok: params.ok,
        muted: params.muted,
    });
    const heartbeatValue = buildStatusHeartbeatValue({ summary: params.summary });
    const lastHeartbeatValue = buildStatusLastHeartbeatValue({
        deep: params.opts.deep,
        gatewayReachable: params.surface.gatewayReachable,
        lastHeartbeat: params.lastHeartbeat,
        warn: params.warn,
        muted: params.muted,
        formatTimeAgo: params.formatTimeAgo,
    });
    const memoryValue = buildStatusMemoryValue({
        memory: params.memory,
        memoryPlugin: params.memoryPlugin,
        ok: params.ok,
        warn: params.warn,
        muted: params.muted,
        resolveMemoryVectorState: params.resolveMemoryVectorState,
        resolveMemoryFtsState: params.resolveMemoryFtsState,
        resolveMemoryCacheSummary: params.resolveMemoryCacheSummary,
    });
    const pluginCompatibilityValue = buildStatusPluginCompatibilityValue({
        notices: params.pluginCompatibility,
        ok: params.ok,
        warn: params.warn,
    });
    return buildStatusOverviewRowsFromSurface({
        surface: params.surface,
        decorateOk: params.ok,
        decorateWarn: params.warn,
        decorateTailscaleOff: params.muted,
        decorateTailscaleWarn: params.warn,
        prefixRows: [{ Item: "OS", Value: `${params.osLabel} · node ${process.versions.node}` }],
        updateValue: params.updateValue,
        agentsValue,
        suffixRows: [
            { Item: "Memory", Value: memoryValue },
            { Item: "Plugin compatibility", Value: pluginCompatibilityValue },
            { Item: "Probes", Value: probesValue },
            { Item: "Events", Value: eventsValue },
            { Item: "Tasks", Value: tasksValue },
            { Item: "Heartbeat", Value: heartbeatValue },
            ...(lastHeartbeatValue ? [{ Item: "Last heartbeat", Value: lastHeartbeatValue }] : []),
            {
                Item: "Sessions",
                Value: buildStatusSessionsOverviewValue({
                    sessions: params.summary.sessions,
                    formatKTokens: params.formatKTokens,
                }),
            },
        ],
        gatewayAuthWarningValue: params.surface.gatewayProbeAuthWarning
            ? params.warn(params.surface.gatewayProbeAuthWarning)
            : null,
    });
}
export function buildStatusAllOverviewRows(params) {
    return buildStatusOverviewRowsFromSurface({
        surface: params.surface,
        tailscaleBackendState: params.tailscaleBackendState,
        includeBackendStateWhenOff: true,
        includeBackendStateWhenOn: true,
        includeDnsNameWhenOff: true,
        prefixRows: [
            { Item: "Version", Value: VERSION },
            { Item: "OS", Value: params.osLabel },
            { Item: "Node", Value: process.versions.node },
            { Item: "Config", Value: params.configPath },
        ],
        middleRows: [
            { Item: "Security", Value: `Run: ${formatCliCommand("openclaw security audit --deep")}` },
        ],
        agentsValue: buildStatusAllAgentsValue({
            agentStatus: params.agentStatus,
        }),
        suffixRows: [
            {
                Item: "Secrets",
                Value: buildStatusSecretsValue(params.secretDiagnosticsCount),
            },
        ],
        gatewaySelfFallbackValue: "unknown",
    });
}
