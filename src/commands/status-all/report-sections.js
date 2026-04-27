import { buildStatusChannelsTableRows, statusChannelsTableColumns } from "./channels-table.js";
import { buildStatusAgentTableRows, buildStatusChannelDetailSections, statusAgentsTableColumns, statusOverviewTableColumns, } from "./report-tables.js";
export function buildStatusOverviewSection(params) {
    return {
        kind: "table",
        title: "Overview",
        width: params.width,
        renderTable: params.renderTable,
        columns: [...statusOverviewTableColumns],
        rows: params.rows,
    };
}
export function buildStatusChannelsSection(params) {
    return {
        kind: "table",
        title: "Channels",
        width: params.width,
        renderTable: params.renderTable,
        columns: statusChannelsTableColumns.map((column) => column.key === "Detail" ? Object.assign({}, column, { minWidth: 28 }) : column),
        rows: buildStatusChannelsTableRows({
            rows: params.rows,
            channelIssues: params.channelIssues,
            ok: params.ok,
            warn: params.warn,
            muted: params.muted,
            accentDim: params.accentDim,
            formatIssueMessage: params.formatIssueMessage,
        }),
    };
}
export function buildStatusChannelsTableSection(params) {
    return {
        kind: "table",
        title: "Channels",
        width: params.width,
        renderTable: params.renderTable,
        columns: [...params.columns],
        rows: params.rows,
    };
}
export function buildStatusChannelDetailsSections(params) {
    return buildStatusChannelDetailSections({
        details: params.details,
        width: params.width,
        renderTable: params.renderTable,
        ok: params.ok,
        warn: params.warn,
    });
}
export function buildStatusAgentsSection(params) {
    return {
        kind: "table",
        title: "Agents",
        width: params.width,
        renderTable: params.renderTable,
        columns: [...statusAgentsTableColumns],
        rows: buildStatusAgentTableRows({
            agentStatus: params.agentStatus,
            ok: params.ok,
            warn: params.warn,
        }),
    };
}
export function buildStatusSessionsSection(params) {
    return {
        kind: "table",
        title: "Sessions",
        width: params.width,
        renderTable: params.renderTable,
        columns: [...params.columns],
        rows: params.rows,
    };
}
export function buildStatusSystemEventsSection(params) {
    return {
        kind: "table",
        title: "System events",
        width: params.width,
        renderTable: params.renderTable,
        columns: [{ key: "Event", header: "Event", flex: true, minWidth: 24 }],
        rows: params.rows ?? [],
        trailer: params.trailer,
        skipIfEmpty: true,
    };
}
export function buildStatusHealthSection(params) {
    return {
        kind: "table",
        title: "Health",
        width: params.width,
        renderTable: params.renderTable,
        columns: [...(params.columns ?? [])],
        rows: params.rows ?? [],
        skipIfEmpty: true,
    };
}
export function buildStatusUsageSection(params) {
    return {
        kind: "lines",
        title: "Usage",
        body: params.usageLines ?? [],
        skipIfEmpty: true,
    };
}
