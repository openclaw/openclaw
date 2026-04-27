export declare const DEFAULT_UNDICI_STREAM_TIMEOUT_MS: number;
/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
export declare let _globalUndiciStreamTimeoutMs: number | undefined;
export declare function ensureGlobalUndiciEnvProxyDispatcher(): void;
export declare function ensureGlobalUndiciStreamTimeouts(opts?: {
    timeoutMs?: number;
}): void;
export declare function resetGlobalUndiciStreamTimeoutsForTests(): void;
