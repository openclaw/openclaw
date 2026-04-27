export type FireAndForgetBoundedHookOptions = {
    maxConcurrency?: number;
    maxQueue?: number;
    timeoutMs?: number;
};
export declare function formatHookErrorForLog(err: unknown): string;
export declare function fireAndForgetHook(task: Promise<unknown>, label: string, logger?: (message: string) => void): void;
export declare function fireAndForgetBoundedHook(task: () => Promise<unknown>, label: string, logger?: (message: string) => void, options?: FireAndForgetBoundedHookOptions): void;
