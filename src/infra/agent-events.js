// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map();
const listeners = new Set();
const runContextById = new Map();
export function registerAgentRunContext(runId, context) {
    if (!runId) {
        return;
    }
    const existing = runContextById.get(runId);
    if (!existing) {
        runContextById.set(runId, { ...context });
        return;
    }
    if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
        existing.sessionKey = context.sessionKey;
    }
    if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
        existing.verboseLevel = context.verboseLevel;
    }
    if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
        existing.isHeartbeat = context.isHeartbeat;
    }
}
export function getAgentRunContext(runId) {
    return runContextById.get(runId);
}
export function clearAgentRunContext(runId) {
    runContextById.delete(runId);
}
export function resetAgentRunContextForTest() {
    runContextById.clear();
}
export function emitAgentEvent(event) {
    const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
    seqByRun.set(event.runId, nextSeq);
    const context = runContextById.get(event.runId);
    const sessionKey = typeof event.sessionKey === "string" && event.sessionKey.trim()
        ? event.sessionKey
        : context?.sessionKey;
    const enriched = {
        ...event,
        sessionKey,
        seq: nextSeq,
        ts: Date.now(),
    };
    for (const listener of listeners) {
        try {
            listener(enriched);
        }
        catch {
            /* ignore */
        }
    }
}
export function onAgentEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
