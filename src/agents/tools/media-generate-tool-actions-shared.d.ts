type MediaGenerateActionResult = {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: Record<string, unknown>;
};
type TaskStatusTextBuilder<Task> = (task: Task, params?: {
    duplicateGuard?: boolean;
}) => string;
type MediaGenerateProvider = {
    id: string;
    defaultModel?: string;
    models?: string[];
    capabilities: unknown;
};
export type { MediaGenerateActionResult };
export declare function createMediaGenerateProviderListActionResult<TProvider extends MediaGenerateProvider>(params: {
    providers: TProvider[];
    emptyText: string;
    listModes: (provider: TProvider) => string[];
    summarizeCapabilities: (provider: TProvider) => string;
}): MediaGenerateActionResult;
export declare function createMediaGenerateTaskStatusActions<Task>(params: {
    inactiveText: string;
    findActiveTask: (sessionKey?: string) => Task | undefined;
    buildStatusText: TaskStatusTextBuilder<Task>;
    buildStatusDetails: (task: Task) => Record<string, unknown>;
}): {
    createStatusActionResult(sessionKey?: string): MediaGenerateActionResult;
    createDuplicateGuardResult(sessionKey?: string): MediaGenerateActionResult | undefined;
};
export declare function createMediaGenerateStatusActionResult<Task>(params: {
    sessionKey?: string;
    inactiveText: string;
    findActiveTask: (sessionKey?: string) => Task | undefined;
    buildStatusText: TaskStatusTextBuilder<Task>;
    buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult;
export declare function createMediaGenerateDuplicateGuardResult<Task>(params: {
    sessionKey?: string;
    findActiveTask: (sessionKey?: string) => Task | undefined;
    buildStatusText: TaskStatusTextBuilder<Task>;
    buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult | undefined;
