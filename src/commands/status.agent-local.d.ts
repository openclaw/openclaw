import type { OpenClawConfig } from "../config/types.js";
export type AgentLocalStatus = {
    id: string;
    name?: string;
    workspaceDir: string | null;
    bootstrapPending: boolean | null;
    sessionsPath: string;
    sessionsCount: number;
    lastUpdatedAt: number | null;
    lastActiveAgeMs: number | null;
};
type AgentLocalStatusesResult = {
    defaultId: string;
    agents: AgentLocalStatus[];
    totalSessions: number;
    bootstrapPendingCount: number;
};
export declare function getAgentLocalStatuses(cfg: OpenClawConfig): Promise<AgentLocalStatusesResult>;
export {};
