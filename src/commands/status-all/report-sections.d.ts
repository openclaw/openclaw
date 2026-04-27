import type { RenderTableOptions, TableColumn } from "../../terminal/table.js";
import type { StatusReportSection } from "./text-report.js";
type TableRenderer = (input: RenderTableOptions) => string;
export declare function buildStatusOverviewSection(params: {
    width: number;
    renderTable: TableRenderer;
    rows: Array<{
        Item: string;
        Value: string;
    }>;
}): StatusReportSection;
export declare function buildStatusChannelsSection(params: {
    width: number;
    renderTable: TableRenderer;
    rows: Array<{
        id: string;
        label: string;
        enabled: boolean;
        state: "ok" | "warn" | "off" | "setup";
        detail: string;
    }>;
    channelIssues: Array<{
        channel: string;
        message: string;
    }>;
    ok: (text: string) => string;
    warn: (text: string) => string;
    muted: (text: string) => string;
    accentDim: (text: string) => string;
    formatIssueMessage?: (message: string) => string;
}): StatusReportSection;
export declare function buildStatusChannelsTableSection(params: {
    width: number;
    renderTable: TableRenderer;
    columns: readonly TableColumn[];
    rows: Array<Record<string, string>>;
}): StatusReportSection;
export declare function buildStatusChannelDetailsSections(params: {
    details: Array<{
        title: string;
        columns: string[];
        rows: Array<Record<string, string>>;
    }>;
    width: number;
    renderTable: TableRenderer;
    ok: (text: string) => string;
    warn: (text: string) => string;
}): StatusReportSection[];
export declare function buildStatusAgentsSection(params: {
    width: number;
    renderTable: TableRenderer;
    agentStatus: {
        agents: Array<{
            id: string;
            name?: string | null;
            bootstrapPending?: boolean | null;
            sessionsCount: number;
            lastActiveAgeMs?: number | null;
            sessionsPath: string;
        }>;
    };
    ok: (text: string) => string;
    warn: (text: string) => string;
}): StatusReportSection;
export declare function buildStatusSessionsSection(params: {
    width: number;
    renderTable: TableRenderer;
    columns: readonly TableColumn[];
    rows: Array<Record<string, string>>;
}): StatusReportSection;
export declare function buildStatusSystemEventsSection(params: {
    width: number;
    renderTable: TableRenderer;
    rows?: Array<Record<string, string>>;
    trailer?: string | null;
}): StatusReportSection;
export declare function buildStatusHealthSection(params: {
    width: number;
    renderTable: TableRenderer;
    columns?: readonly TableColumn[];
    rows?: Array<Record<string, string>>;
}): StatusReportSection;
export declare function buildStatusUsageSection(params: {
    usageLines?: string[];
}): StatusReportSection;
export {};
