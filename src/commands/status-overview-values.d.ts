type AgentStatusLike = {
    bootstrapPendingCount: number;
    totalSessions: number;
    agents: Array<{
        id: string;
        lastActiveAgeMs?: number | null;
    }>;
};
type PluginCompatibilityNoticeLike = {
    pluginId?: string | null;
    plugin?: string | null;
};
type SummarySessionsLike = {
    count: number;
    paths: string[];
    defaults: {
        model?: string | null;
        contextTokens?: number | null;
    };
};
export declare function countActiveStatusAgents(params: {
    agentStatus: AgentStatusLike;
    activeThresholdMs?: number;
}): number;
export declare function buildStatusAllAgentsValue(params: {
    agentStatus: AgentStatusLike;
    activeThresholdMs?: number;
}): string;
export declare function buildStatusSecretsValue(count: number): string;
export declare function buildStatusEventsValue(params: {
    queuedSystemEvents: string[];
}): string;
export declare function buildStatusProbesValue(params: {
    health?: unknown;
    ok: (value: string) => string;
    muted: (value: string) => string;
}): string;
export declare function buildStatusPluginCompatibilityValue(params: {
    notices: PluginCompatibilityNoticeLike[];
    ok: (value: string) => string;
    warn: (value: string) => string;
}): string;
export declare function buildStatusSessionsOverviewValue(params: {
    sessions: SummarySessionsLike;
    formatKTokens: (value: number) => string;
}): string;
export {};
