export type FatalErrorHookContext = {
    reason: string;
    error?: unknown;
};
export type FatalErrorHook = (context: FatalErrorHookContext) => string | undefined | void;
export declare function registerFatalErrorHook(hook: FatalErrorHook): () => void;
export declare function runFatalErrorHooks(context: FatalErrorHookContext): string[];
export declare function resetFatalErrorHooksForTest(): void;
