import { buildStatusChannelsTableSection, buildStatusHealthSection, buildStatusOverviewSection, buildStatusSessionsSection, buildStatusSystemEventsSection, buildStatusUsageSection, } from "./status-all/report-sections.js";
import { appendStatusReportSections } from "./status-all/text-report.js";
export async function buildStatusCommandReportLines(params) {
    const lines = [];
    lines.push(params.heading("OpenClaw status"));
    appendStatusReportSections({
        lines,
        heading: params.heading,
        sections: [
            {
                ...buildStatusOverviewSection({
                    width: params.width,
                    renderTable: params.renderTable,
                    rows: params.overviewRows,
                }),
            },
            {
                kind: "raw",
                body: params.showTaskMaintenanceHint ? ["", params.muted(params.taskMaintenanceHint)] : [],
                skipIfEmpty: true,
            },
            {
                kind: "lines",
                title: "Plugin compatibility",
                body: params.pluginCompatibilityLines,
                skipIfEmpty: true,
            },
            {
                kind: "raw",
                body: params.pairingRecoveryLines.length > 0 ? ["", ...params.pairingRecoveryLines] : [],
                skipIfEmpty: true,
            },
            {
                kind: "lines",
                title: "Security audit",
                body: params.securityAuditLines,
            },
            {
                ...buildStatusChannelsTableSection({
                    width: params.width,
                    renderTable: params.renderTable,
                    columns: params.channelsColumns,
                    rows: params.channelsRows,
                }),
            },
            {
                ...buildStatusSessionsSection({
                    width: params.width,
                    renderTable: params.renderTable,
                    columns: params.sessionsColumns,
                    rows: params.sessionsRows,
                }),
            },
            {
                ...buildStatusSystemEventsSection({
                    width: params.width,
                    renderTable: params.renderTable,
                    rows: params.systemEventsRows,
                    trailer: params.systemEventsTrailer,
                }),
            },
            {
                ...buildStatusHealthSection({
                    width: params.width,
                    renderTable: params.renderTable,
                    columns: params.healthColumns,
                    rows: params.healthRows,
                }),
            },
            {
                ...buildStatusUsageSection({ usageLines: params.usageLines }),
            },
            {
                kind: "raw",
                body: ["", ...params.footerLines],
            },
        ],
    });
    return lines;
}
