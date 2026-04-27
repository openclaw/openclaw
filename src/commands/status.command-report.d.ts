import type { RenderTableOptions, TableColumn } from "../terminal/table.js";
export declare function buildStatusCommandReportLines(params: {
    heading: (text: string) => string;
    muted: (text: string) => string;
    renderTable: (input: RenderTableOptions) => string;
    width: number;
    overviewRows: Array<{
        Item: string;
        Value: string;
    }>;
    showTaskMaintenanceHint: boolean;
    taskMaintenanceHint: string;
    pluginCompatibilityLines: string[];
    pairingRecoveryLines: string[];
    securityAuditLines: string[];
    channelsColumns: readonly TableColumn[];
    channelsRows: Array<Record<string, string>>;
    sessionsColumns: readonly TableColumn[];
    sessionsRows: Array<Record<string, string>>;
    systemEventsRows?: Array<Record<string, string>>;
    systemEventsTrailer?: string | null;
    healthColumns?: readonly TableColumn[];
    healthRows?: Array<Record<string, string>>;
    usageLines?: string[];
    footerLines: string[];
}): Promise<string[]>;
