import { isAbortRequestText } from "../auto-reply/reply/abort.js";
export function isChatStopCommandText(text) {
    return isAbortRequestText(text);
}
export function resolveChatRunExpiresAtMs(params) {
    const { now, timeoutMs, graceMs = 60000, minMs = 2 * 60000, maxMs = 24 * 60 * 60000 } = params;
    const boundedTimeoutMs = Math.max(0, timeoutMs);
    const target = now + boundedTimeoutMs + graceMs;
    const min = now + minMs;
    const max = now + maxMs;
    return Math.min(max, Math.max(min, target));
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
