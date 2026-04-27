import type { RenderTableOptions } from "../../terminal/table.js";
import type { StatusReportSection } from "./text-report.js";
type AgentStatusLike = {
    agents: Array<{
        id: string;
        name?: string | null;
        bootstrapPending?: boolean | null;
        sessionsCount: number;
        lastActiveAgeMs?: number | null;
        sessionsPath: string;
    }>;
};
type ChannelDetailLike = {
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
};
export declare const statusOverviewTableColumns: readonly [{
    readonly key: "Item";
    readonly header: "Item";
    readonly minWidth: 10;
}, {
    readonly key: "Value";
    readonly header: "Value";
    readonly flex: true;
    readonly minWidth: 24;
}];
export declare const statusAgentsTableColumns: readonly [{
    readonly key: "Agent";
    readonly header: "Agent";
    readonly minWidth: 12;
}, {
    readonly key: "BootstrapFile";
    readonly header: "Bootstrap file";
    readonly minWidth: 14;
}, {
    readonly key: "Sessions";
    readonly header: "Sessions";
    readonly align: "right";
    readonly minWidth: 8;
}, {
    readonly key: "Active";
    readonly header: "Active";
    readonly minWidth: 10;
}, {
    readonly key: "Store";
    readonly header: "Store";
    readonly flex: true;
    readonly minWidth: 34;
}];
export declare function buildStatusAgentTableRows(params: {
    agentStatus: AgentStatusLike;
    ok: (text: string) => string;
    warn: (text: string) => string;
}): {
    Agent: string;
    BootstrapFile: string;
    Sessions: string;
    Active: string;
    Store: string;
}[];
export declare function buildStatusChannelDetailSections(params: {
    details: ChannelDetailLike[];
    width: number;
    renderTable: (input: RenderTableOptions) => string;
    ok: (text: string) => string;
    warn: (text: string) => string;
}): StatusReportSection[];
export {};
