export type TypingCallbacks = {
    onReplyStart: () => Promise<void>;
    onIdle?: () => void;
    /** Called when the typing controller is cleaned up (e.g. on NO_REPLY). */
    onCleanup?: () => void;
};
export type CreateTypingCallbacksParams = {
    start: () => Promise<void>;
    stop?: () => Promise<void>;
    onStartError: (err: unknown) => void;
    onStopError?: (err: unknown) => void;
    keepaliveIntervalMs?: number;
    /** Stop keepalive after this many consecutive start() failures. Default: 2 */
    maxConsecutiveFailures?: number;
    /** Maximum duration for typing indicator before auto-cleanup (safety TTL). Default: 60s */
    maxDurationMs?: number;
};
export declare function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks;
