import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
export declare function buildColdStartUpdateResult(): UpdateCheckResult;
export declare function buildColdStartAgentLocalStatuses(): {
    defaultId: string;
    agents: never[];
    totalSessions: number;
    bootstrapPendingCount: number;
};
export declare function buildColdStartStatusSummary(): {
    runtimeVersion: null;
    heartbeat: {
        defaultAgentId: string;
        agents: never[];
    };
    channelSummary: never[];
    queuedSystemEvents: never[];
    tasks: import("../tasks/task-registry.types.js").TaskRegistrySummary;
    taskAudit: import("../tasks/task-registry.audit.shared.js").TaskAuditSummary;
    sessions: {
        paths: never[];
        count: number;
        defaults: {
            model: null;
            contextTokens: null;
        };
        recent: never[];
        byAgent: never[];
    };
};
export declare function shouldSkipStatusScanNetworkChecks(params: {
    coldStart: boolean;
    hasConfiguredChannels: boolean;
    all?: boolean;
}): boolean;
type StatusScanExecRunner = (command: string, args: string[], opts?: number | {
    timeoutMs?: number;
    maxBuffer?: number;
    cwd?: string;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
type StatusScanCoreBootstrapParams<TAgentStatus> = {
    coldStart: boolean;
    cfg: OpenClawConfig;
    hasConfiguredChannels: boolean;
    opts: {
        timeoutMs?: number;
        all?: boolean;
    };
    getTailnetHostname: (runner: StatusScanExecRunner) => Promise<string | null>;
    getUpdateCheckResult: (params: {
        timeoutMs: number;
        fetchGit: boolean;
        includeRegistry: boolean;
    }) => Promise<UpdateCheckResult>;
    getAgentLocalStatuses: (cfg: OpenClawConfig) => Promise<TAgentStatus>;
};
type StatusScanBootstrapParams<TAgentStatus, TSummary> = StatusScanCoreBootstrapParams<TAgentStatus> & {
    sourceConfig: OpenClawConfig;
    getStatusSummary: (params: {
        config: OpenClawConfig;
        sourceConfig: OpenClawConfig;
    }) => Promise<TSummary>;
};
export declare function createStatusScanCoreBootstrap<TAgentStatus>(params: StatusScanCoreBootstrapParams<TAgentStatus>): Promise<{
    tailscaleMode: import("../config/types.gateway.js").GatewayTailscaleMode;
    tailscaleDnsPromise: Promise<string | null>;
    updatePromise: Promise<UpdateCheckResult>;
    agentStatusPromise: Promise<TAgentStatus>;
    gatewayProbePromise: Promise<import("./status.scan.shared.js").GatewayProbeSnapshot>;
    skipColdStartNetworkChecks: boolean;
    resolveTailscaleHttpsUrl: () => Promise<string | null>;
}>;
export declare function createStatusScanBootstrap<TAgentStatus, TSummary>(params: StatusScanBootstrapParams<TAgentStatus, TSummary>): Promise<{
    summaryPromise: Promise<TSummary>;
    tailscaleMode: import("../config/types.gateway.js").GatewayTailscaleMode;
    tailscaleDnsPromise: Promise<string | null>;
    updatePromise: Promise<UpdateCheckResult>;
    agentStatusPromise: Promise<TAgentStatus>;
    gatewayProbePromise: Promise<import("./status.scan.shared.js").GatewayProbeSnapshot>;
    skipColdStartNetworkChecks: boolean;
    resolveTailscaleHttpsUrl: () => Promise<string | null>;
}>;
export {};
