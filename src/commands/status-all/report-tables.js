import { formatTimeAgo } from "./format.js";
export const statusOverviewTableColumns = [
    { key: "Item", header: "Item", minWidth: 10 },
    { key: "Value", header: "Value", flex: true, minWidth: 24 },
];
export const statusAgentsTableColumns = [
    { key: "Agent", header: "Agent", minWidth: 12 },
    { key: "BootstrapFile", header: "Bootstrap file", minWidth: 14 },
    { key: "Sessions", header: "Sessions", align: "right", minWidth: 8 },
    { key: "Active", header: "Active", minWidth: 10 },
    { key: "Store", header: "Store", flex: true, minWidth: 34 },
];
export function buildStatusAgentTableRows(params) {
    return params.agentStatus.agents.map((agent) => ({
        Agent: agent.name?.trim() ? `${agent.id} (${agent.name.trim()})` : agent.id,
        BootstrapFile: agent.bootstrapPending === true
            ? params.warn("PRESENT")
            : agent.bootstrapPending === false
                ? params.ok("ABSENT")
                : "unknown",
        Sessions: String(agent.sessionsCount),
        Active: agent.lastActiveAgeMs != null ? formatTimeAgo(agent.lastActiveAgeMs) : "unknown",
        Store: agent.sessionsPath,
    }));
}
export function buildStatusChannelDetailSections(params) {
    return params.details.map((detail) => ({
        kind: "table",
        title: detail.title,
        width: params.width,
        renderTable: params.renderTable,
        columns: detail.columns.map((column) => ({
            key: column,
            header: column,
            flex: column === "Notes",
            minWidth: column === "Notes" ? 28 : 10,
        })),
        rows: detail.rows.map((row) => ({
            ...row,
            ...(row.Status === "OK"
                ? { Status: params.ok("OK") }
                : row.Status === "WARN"
                    ? { Status: params.warn("WARN") }
                    : {}),
        })),
    }));
}
