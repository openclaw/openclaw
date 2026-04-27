export type CrestodianAuditEntry = {
    timestamp: string;
    operation: string;
    summary: string;
    configPath?: string;
    configHashBefore?: string | null;
    configHashAfter?: string | null;
    details?: Record<string, unknown>;
};
export declare function resolveCrestodianAuditPath(env?: NodeJS.ProcessEnv, stateDir?: string): string;
export declare function appendCrestodianAuditEntry(entry: Omit<CrestodianAuditEntry, "timestamp">, opts?: {
    env?: NodeJS.ProcessEnv;
    auditPath?: string;
}): Promise<string>;
