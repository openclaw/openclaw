import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
const DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 60_000;
export function isChatStopCommandText(text) {
    return isAbortRequestText(text);
}
export function resolveChatRunExpiresAtMs(params) {
    const { now, timeoutMs, graceMs = DEFAULT_CHAT_RUN_ABORT_GRACE_MS, minMs = 2 * 60_000, maxMs = 24 * 60 * 60_000, } = params;
    const boundedTimeoutMs = Math.max(0, timeoutMs);
    const target = now + boundedTimeoutMs + graceMs;
    const min = now + minMs;
    const max = now + maxMs;
    return Math.min(max, Math.max(min, target));
}
export function resolveAgentRunExpiresAtMs(params) {
    const graceMs = Math.max(0, params.graceMs ?? DEFAULT_CHAT_RUN_ABORT_GRACE_MS);
    return resolveChatRunExpiresAtMs({
        now: params.now,
        timeoutMs: params.timeoutMs,
        graceMs,
        minMs: graceMs,
        maxMs: Math.max(0, params.timeoutMs) + graceMs,
    });
}
export function registerChatAbortController(params) {
    const controller = new AbortController();
    const cleanup = () => {
        const entry = params.chatAbortControllers.get(params.runId);
        if (entry?.controller === controller) {
            params.chatAbortControllers.delete(params.runId);
        }
    };
    if (!params.sessionKey || params.chatAbortControllers.has(params.runId)) {
        return { controller, registered: false, cleanup };
    }
    const now = params.now ?? Date.now();
    const entry = {
        controller,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        startedAtMs: now,
        expiresAtMs: params.expiresAtMs ?? resolveChatRunExpiresAtMs({ now, timeoutMs: params.timeoutMs }),
        ownerConnId: params.ownerConnId,
        ownerDeviceId: params.ownerDeviceId,
        kind: params.kind,
    };
    params.chatAbortControllers.set(params.runId, entry);
    return { controller, registered: true, entry, cleanup };
}
function broadcastChatAborted(ops, params) {
    const { runId, sessionKey, stopReason, partialText } = params;
    const payload = {
        runId,
        sessionKey,
        seq: (ops.agentRunSeq.get(runId) ?? 0) + 1,
        state: "aborted",
        stopReason,
        message: partialText
            ? {
                role: "assistant",
                content: [{ type: "text", text: partialText }],
                timestamp: Date.now(),
            }
            : undefined,
    };
    ops.broadcast("chat", payload);
    ops.nodeSendToSession(sessionKey, "chat", payload);
}
export function abortChatRunById(ops, params) {
    const { runId, sessionKey, stopReason } = params;
    const active = ops.chatAbortControllers.get(runId);
    if (!active) {
        return { aborted: false };
    }
    if (active.sessionKey !== sessionKey) {
        return { aborted: false };
    }
    const bufferedText = ops.chatRunBuffers.get(runId);
    const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
    ops.chatAbortedRuns.set(runId, Date.now());
    active.controller.abort();
    ops.chatAbortControllers.delete(runId);
    ops.chatRunBuffers.delete(runId);
    ops.chatDeltaSentAt.delete(runId);
    ops.chatDeltaLastBroadcastLen.delete(runId);
    const removed = ops.removeChatRun(runId, runId, sessionKey);
    broadcastChatAborted(ops, { runId, sessionKey, stopReason, partialText });
    ops.agentRunSeq.delete(runId);
    if (removed?.clientRunId) {
        ops.agentRunSeq.delete(removed.clientRunId);
    }
    return { aborted: true };
}
export function abortChatRunsForSessionKey(ops, params) {
    const { sessionKey, stopReason } = params;
    const runIds = [];
    for (const [runId, active] of ops.chatAbortControllers) {
        if (active.sessionKey !== sessionKey) {
            continue;
        }
        const res = abortChatRunById(ops, { runId, sessionKey, stopReason });
        if (res.aborted) {
            runIds.push(runId);
        }
    }
    return { aborted: runIds.length > 0, runIds };
}
