export type ReplyRunKey = string;
export type ReplyBackendKind = "embedded" | "cli";
export type ReplyBackendCancelReason = "user_abort" | "restart" | "superseded";
export type ReplyBackendHandle = {
    readonly kind: ReplyBackendKind;
    cancel(reason?: ReplyBackendCancelReason): void;
    isStreaming(): boolean;
    queueMessage?: (text: string) => Promise<void>;
    /**
     * Compatibility-only hook so legacy "abort compacting runs" paths can still
     * find embedded runs that are compacting during the main run phase.
     */
    isCompacting?: () => boolean;
};
export type ReplyOperationPhase = "queued" | "preflight_compacting" | "memory_flushing" | "running" | "completed" | "failed" | "aborted";
export type ReplyOperationFailureCode = "gateway_draining" | "command_lane_cleared" | "aborted_by_user" | "session_corruption_reset" | "run_failed";
export type ReplyOperationAbortCode = "aborted_by_user" | "aborted_for_restart";
export type ReplyOperationResult = {
    kind: "completed";
} | {
    kind: "failed";
    code: ReplyOperationFailureCode;
    cause?: unknown;
} | {
    kind: "aborted";
    code: ReplyOperationAbortCode;
};
export type ReplyOperation = {
    readonly key: ReplyRunKey;
    readonly sessionId: string;
    readonly abortSignal: AbortSignal;
    readonly resetTriggered: boolean;
    readonly phase: ReplyOperationPhase;
    readonly result: ReplyOperationResult | null;
    setPhase(next: "queued" | "preflight_compacting" | "memory_flushing" | "running"): void;
    updateSessionId(nextSessionId: string): void;
    attachBackend(handle: ReplyBackendHandle): void;
    detachBackend(handle: ReplyBackendHandle): void;
    complete(): void;
    fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
    abortByUser(): void;
    abortForRestart(): void;
};
export type ReplyRunRegistry = {
    begin(params: {
        sessionKey: string;
        sessionId: string;
        resetTriggered: boolean;
        upstreamAbortSignal?: AbortSignal;
    }): ReplyOperation;
    get(sessionKey: string): ReplyOperation | undefined;
    isActive(sessionKey: string): boolean;
    isStreaming(sessionKey: string): boolean;
    abort(sessionKey: string): boolean;
    waitForIdle(sessionKey: string, timeoutMs?: number): Promise<boolean>;
    resolveSessionId(sessionKey: string): string | undefined;
};
export declare class ReplyRunAlreadyActiveError extends Error {
    constructor(sessionKey: string);
}
export declare function createReplyOperation(params: {
    sessionKey: string;
    sessionId: string;
    resetTriggered: boolean;
    upstreamAbortSignal?: AbortSignal;
}): ReplyOperation;
export declare const replyRunRegistry: ReplyRunRegistry;
export declare function resolveActiveReplyRunSessionId(sessionKey: string): string | undefined;
export declare function isReplyRunActiveForSessionId(sessionId: string): boolean;
export declare function isReplyRunStreamingForSessionId(sessionId: string): boolean;
export declare function queueReplyRunMessage(sessionId: string, text: string): boolean;
export declare function abortReplyRunBySessionId(sessionId: string): boolean;
export declare function waitForReplyRunEndBySessionId(sessionId: string, timeoutMs?: number): Promise<boolean>;
export declare function abortActiveReplyRuns(opts: {
    mode: "all" | "compacting";
}): boolean;
export declare function getActiveReplyRunCount(): number;
export declare function listActiveReplyRunSessionIds(): string[];
export declare const __testing: {
    resetReplyRunRegistry(): void;
};
