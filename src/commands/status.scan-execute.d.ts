import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import { type StatusScanResult } from "./status.scan-result.ts";
import { type MemoryPluginStatus, type MemoryStatusSnapshot } from "./status.scan.shared.js";
export declare function executeStatusScanFromOverview(params: {
    overview: StatusScanOverviewResult;
    runtime?: RuntimeEnv;
    summary?: {
        includeChannelSummary?: boolean;
    };
    resolveMemory: (args: {
        cfg: StatusScanOverviewResult["cfg"];
        agentStatus: StatusScanOverviewResult["agentStatus"];
        memoryPlugin: MemoryPluginStatus;
        runtime?: RuntimeEnv;
    }) => Promise<MemoryStatusSnapshot | null>;
    channelIssues: StatusScanResult["channelIssues"];
    channels: StatusScanResult["channels"];
    pluginCompatibility: PluginCompatibilityNotice[];
}): Promise<StatusScanResult>;
