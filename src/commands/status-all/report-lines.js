import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { isRich, theme } from "../../terminal/theme.js";
import { appendStatusAllDiagnosis } from "./diagnosis.js";
import { buildStatusAgentsSection, buildStatusChannelDetailsSections, buildStatusChannelsSection, buildStatusOverviewSection, } from "./report-sections.js";
import { appendStatusReportSections, appendStatusSectionHeading } from "./text-report.js";
export async function buildStatusAllReportLines(params) {
    const rich = isRich();
    const heading = (text) => (rich ? theme.heading(text) : text);
    const ok = (text) => (rich ? theme.success(text) : text);
    const warn = (text) => (rich ? theme.warn(text) : text);
    const fail = (text) => (rich ? theme.error(text) : text);
    const muted = (text) => (rich ? theme.muted(text) : text);
    const tableWidth = getTerminalTableWidth();
    const lines = [];
    lines.push(heading("OpenClaw status --all"));
    appendStatusReportSections({
        lines,
        heading,
        sections: [
            buildStatusOverviewSection({
                width: tableWidth,
                renderTable,
                rows: params.overviewRows,
            }),
            buildStatusChannelsSection({
                width: tableWidth,
                renderTable,
                rows: params.channels.rows,
                channelIssues: params.channelIssues,
                ok,
                warn,
                muted,
                accentDim: theme.accentDim,
                formatIssueMessage: (message) => message.slice(0, 90),
            }),
            ...buildStatusChannelDetailsSections({
                details: params.channels.details,
                width: tableWidth,
                renderTable,
                ok,
                warn,
            }),
            buildStatusAgentsSection({
                width: tableWidth,
                renderTable,
                agentStatus: params.agentStatus,
                ok,
                warn,
            }),
        ],
    });
    appendStatusSectionHeading({
        lines,
        heading,
        title: "Diagnosis (read-only)",
    });
    await appendStatusAllDiagnosis({
        lines,
        progress: params.progress,
        muted,
        ok,
        warn,
        fail,
        connectionDetailsForReport: params.connectionDetailsForReport,
        ...params.diagnosis,
    });
    return lines;
}
