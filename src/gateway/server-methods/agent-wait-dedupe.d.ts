import type { DedupeEntry } from "../server-shared.js";
export type AgentWaitTerminalSnapshot = {
    status: "ok" | "error" | "timeout";
    startedAt?: number;
    endedAt?: number;
    error?: string;
};
export declare function readTerminalSnapshotFromDedupeEntry(entry: DedupeEntry): AgentWaitTerminalSnapshot | null;
export declare function readTerminalSnapshotFromGatewayDedupe(params: {
    dedupe: Map<string, DedupeEntry>;
    runId: string;
    ignoreAgentTerminalSnapshot?: boolean;
}): AgentWaitTerminalSnapshot | null;
export declare function waitForTerminalGatewayDedupe(params: {
    dedupe: Map<string, DedupeEntry>;
    runId: string;
    timeoutMs: number;
    signal?: AbortSignal;
    ignoreAgentTerminalSnapshot?: boolean;
}): Promise<AgentWaitTerminalSnapshot | null>;
export declare function setGatewayDedupeEntry(params: {
    dedupe: Map<string, DedupeEntry>;
    key: string;
    entry: DedupeEntry;
}): void;
export declare const __testing: {
    getWaiterCount(runId?: string): number;
    resetWaiters(): void;
};
