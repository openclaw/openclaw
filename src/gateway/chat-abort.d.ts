export type ChatAbortControllerEntry = {
    controller: AbortController;
    sessionId: string;
    sessionKey: string;
    startedAtMs: number;
    expiresAtMs: number;
    ownerConnId?: string;
    ownerDeviceId?: string;
    /**
     * Which RPC owns this registration. Absent (undefined) is treated as
     * `"chat-send"` so pre-existing callers that constructed entries without
     * a kind keep their behavior. Consumers that need "chat.send specifically
     * is active" must check `kind !== "agent"`, not just `.has(runId)`.
     */
    kind?: "chat-send" | "agent";
};
export type RegisteredChatAbortController = {
    controller: AbortController;
    registered: boolean;
    entry?: ChatAbortControllerEntry;
    cleanup: () => void;
};
export declare function isChatStopCommandText(text: string): boolean;
export declare function resolveChatRunExpiresAtMs(params: {
    now: number;
    timeoutMs: number;
    graceMs?: number;
    minMs?: number;
    maxMs?: number;
}): number;
export declare function resolveAgentRunExpiresAtMs(params: {
    now: number;
    timeoutMs: number;
    graceMs?: number;
}): number;
export declare function registerChatAbortController(params: {
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
    runId: string;
    sessionId: string;
    sessionKey?: string | null;
    timeoutMs: number;
    ownerConnId?: string;
    ownerDeviceId?: string;
    kind?: ChatAbortControllerEntry["kind"];
    now?: number;
    expiresAtMs?: number;
}): RegisteredChatAbortController;
export type ChatAbortOps = {
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
    chatRunBuffers: Map<string, string>;
    chatDeltaSentAt: Map<string, number>;
    chatDeltaLastBroadcastLen: Map<string, number>;
    chatAbortedRuns: Map<string, number>;
    removeChatRun: (sessionId: string, clientRunId: string, sessionKey?: string) => {
        sessionKey: string;
        clientRunId: string;
    } | undefined;
    agentRunSeq: Map<string, number>;
    broadcast: (event: string, payload: unknown, opts?: {
        dropIfSlow?: boolean;
    }) => void;
    nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
};
export declare function abortChatRunById(ops: ChatAbortOps, params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
}): {
    aborted: boolean;
};
export declare function abortChatRunsForSessionKey(ops: ChatAbortOps, params: {
    sessionKey: string;
    stopReason?: string;
}): {
    aborted: boolean;
    runIds: string[];
};
