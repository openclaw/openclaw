import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");
function getAgentEventState() {
    return resolveGlobalSingleton(AGENT_EVENT_STATE_KEY, () => ({
        seqByRun: new Map(),
        listeners: new Set(),
        runContextById: new Map(),
    }));
}
export function registerAgentRunContext(runId, context) {
    if (!runId) {
        return;
    }
    const state = getAgentEventState();
    const existing = state.runContextById.get(runId);
    if (!existing) {
        state.runContextById.set(runId, {
            ...context,
            registeredAt: context.registeredAt ?? Date.now(),
        });
        return;
    }
    if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
        existing.sessionKey = context.sessionKey;
    }
    if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
        existing.verboseLevel = context.verboseLevel;
    }
    if (context.isControlUiVisible !== undefined) {
        existing.isControlUiVisible = context.isControlUiVisible;
    }
    if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
        existing.isHeartbeat = context.isHeartbeat;
    }
}
export function getAgentRunContext(runId) {
    return getAgentEventState().runContextById.get(runId);
}
export function clearAgentRunContext(runId) {
    const state = getAgentEventState();
    state.runContextById.delete(runId);
    state.seqByRun.delete(runId);
}
/**
 * Sweep stale run contexts that exceeded the given TTL.
 * Guards against orphaned entries when lifecycle "end"/"error" events are missed.
 */
export function sweepStaleRunContexts(maxAgeMs = 30 * 60 * 1000) {
    const state = getAgentEventState();
    const now = Date.now();
    let swept = 0;
    for (const [runId, ctx] of state.runContextById.entries()) {
        // Use lastActiveAt (refreshed on every event) to avoid sweeping active runs.
        // Fall back to registeredAt, then treat missing timestamps as infinitely old.
        const lastSeen = ctx.lastActiveAt ?? ctx.registeredAt;
        const age = lastSeen ? now - lastSeen : Infinity;
        if (age > maxAgeMs) {
            state.runContextById.delete(runId);
            state.seqByRun.delete(runId);
            swept++;
        }
    }
    return swept;
}
export function resetAgentRunContextForTest() {
    getAgentEventState().runContextById.clear();
    getAgentEventState().seqByRun.clear();
}
export function emitAgentEvent(event) {
    const state = getAgentEventState();
    const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
    state.seqByRun.set(event.runId, nextSeq);
    const context = state.runContextById.get(event.runId);
    if (context) {
        context.lastActiveAt = Date.now();
    }
    const isControlUiVisible = context?.isControlUiVisible ?? true;
    const eventSessionKey = typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
    const sessionKey = isControlUiVisible ? (eventSessionKey ?? context?.sessionKey) : undefined;
    const enriched = {
        ...event,
        sessionKey,
        seq: nextSeq,
        ts: Date.now(),
    };
    notifyListeners(state.listeners, enriched);
}
export function emitAgentItemEvent(params) {
    emitAgentEvent({
        runId: params.runId,
        stream: "item",
        data: params.data,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
}
export function emitAgentPlanEvent(params) {
    emitAgentEvent({
        runId: params.runId,
        stream: "plan",
        data: params.data,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
}
export function emitAgentApprovalEvent(params) {
    emitAgentEvent({
        runId: params.runId,
        stream: "approval",
        data: params.data,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
}
export function emitAgentCommandOutputEvent(params) {
    emitAgentEvent({
        runId: params.runId,
        stream: "command_output",
        data: params.data,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
}
export function emitAgentPatchSummaryEvent(params) {
    emitAgentEvent({
        runId: params.runId,
        stream: "patch",
        data: params.data,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
}
export function onAgentEvent(listener) {
    const state = getAgentEventState();
    return registerListener(state.listeners, listener);
}
export function resetAgentEventsForTest() {
    const state = getAgentEventState();
    state.seqByRun.clear();
    state.listeners.clear();
    state.runContextById.clear();
}
