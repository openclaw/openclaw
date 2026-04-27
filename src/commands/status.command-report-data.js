import { buildStatusChannelsTableRows, statusChannelsTableColumns, } from "./status-all/channels-table.js";
import { buildStatusCommandOverviewRows } from "./status-overview-rows.ts";
import { buildStatusFooterLines, buildStatusHealthRows, buildStatusPairingRecoveryLines, buildStatusPluginCompatibilityLines, buildStatusSecurityAuditLines, buildStatusSessionsRows, buildStatusSystemEventsRows, buildStatusSystemEventsTrailer, statusHealthColumns, } from "./status.command-sections.js";
export async function buildStatusCommandReportData(params) {
    const overviewRows = buildStatusCommandOverviewRows({
        opts: params.opts,
        surface: params.surface,
        osLabel: params.osSummary.label,
        summary: params.summary,
        health: params.health,
        lastHeartbeat: params.lastHeartbeat,
        agentStatus: params.agentStatus,
        memory: params.memory,
        memoryPlugin: params.memoryPlugin,
        pluginCompatibility: params.pluginCompatibility,
        ok: params.ok,
        warn: params.warn,
        muted: params.muted,
        formatTimeAgo: params.formatTimeAgo,
        formatKTokens: params.formatKTokens,
        resolveMemoryVectorState: params.resolveMemoryVectorState,
        resolveMemoryFtsState: params.resolveMemoryFtsState,
        resolveMemoryCacheSummary: params.resolveMemoryCacheSummary,
        updateValue: params.updateValue,
    });
    const sessionsColumns = [
        { key: "Key", header: "Key", minWidth: 20, flex: true },
        { key: "Kind", header: "Kind", minWidth: 6 },
        { key: "Age", header: "Age", minWidth: 9 },
        { key: "Model", header: "Model", minWidth: 14 },
        { key: "Tokens", header: "Tokens", minWidth: 16 },
        ...(params.opts.verbose ? [{ key: "Cache", header: "Cache", minWidth: 16, flex: true }] : []),
    ];
    const securityAudit = params.securityAudit ?? {
        summary: { critical: 0, warn: 0, info: 0 },
        findings: [],
    };
    return {
        heading: params.theme.heading,
        muted: params.theme.muted,
        renderTable: params.renderTable,
        width: params.tableWidth,
        overviewRows,
        showTaskMaintenanceHint: params.summary.taskAudit.errors > 0,
        taskMaintenanceHint: `Task maintenance: ${params.formatCliCommand("openclaw tasks maintenance --apply")}`,
        pluginCompatibilityLines: buildStatusPluginCompatibilityLines({
            notices: params.pluginCompatibility,
            formatNotice: params.formatPluginCompatibilityNotice,
            warn: params.theme.warn,
            muted: params.theme.muted,
        }),
        pairingRecoveryLines: buildStatusPairingRecoveryLines({
            pairingRecovery: params.pairingRecovery,
            warn: params.theme.warn,
            muted: params.theme.muted,
            formatCliCommand: params.formatCliCommand,
        }),
        securityAuditLines: buildStatusSecurityAuditLines({
            securityAudit,
            theme: params.theme,
            shortenText: params.shortenText,
            formatCliCommand: params.formatCliCommand,
        }),
        channelsColumns: statusChannelsTableColumns,
        channelsRows: buildStatusChannelsTableRows({
            rows: params.channels.rows,
            channelIssues: params.channelIssues,
            ok: params.ok,
            warn: params.warn,
            muted: params.muted,
            accentDim: params.accentDim,
            formatIssueMessage: (message) => params.shortenText(message, 84),
        }),
        sessionsColumns,
        sessionsRows: buildStatusSessionsRows({
            recent: params.summary.sessions.recent,
            verbose: params.opts.verbose,
            shortenText: params.shortenText,
            formatTimeAgo: params.formatTimeAgo,
            formatTokensCompact: params.formatTokensCompact,
            formatPromptCacheCompact: params.formatPromptCacheCompact,
            muted: params.muted,
        }),
        systemEventsRows: buildStatusSystemEventsRows({
            queuedSystemEvents: params.summary.queuedSystemEvents,
        }),
        systemEventsTrailer: buildStatusSystemEventsTrailer({
            queuedSystemEvents: params.summary.queuedSystemEvents,
            muted: params.muted,
        }),
        healthColumns: params.health ? statusHealthColumns : undefined,
        healthRows: params.health
            ? buildStatusHealthRows({
                health: params.health,
                formatHealthChannelLines: params.formatHealthChannelLines,
                ok: params.ok,
                warn: params.warn,
                muted: params.muted,
            })
            : undefined,
        usageLines: params.usageLines,
        footerLines: buildStatusFooterLines({
            updateHint: params.formatUpdateAvailableHint(params.surface.update),
            warn: params.theme.warn,
            formatCliCommand: params.formatCliCommand,
            nodeOnlyGateway: params.surface.nodeOnlyGateway,
            gatewayReachable: params.surface.gatewayReachable,
        }),
    };
}
