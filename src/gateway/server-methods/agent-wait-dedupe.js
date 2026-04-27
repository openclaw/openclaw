import { setSafeTimeout } from "../../utils/timer-delay.js";
const AGENT_WAITERS_BY_RUN_ID = new Map();
function parseRunIdFromDedupeKey(key) {
    if (key.startsWith("agent:")) {
        return key.slice("agent:".length) || null;
    }
    if (key.startsWith("chat:")) {
        return key.slice("chat:".length) || null;
    }
    return null;
}
function asFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function removeWaiter(runId, waiter) {
    const waiters = AGENT_WAITERS_BY_RUN_ID.get(runId);
    if (!waiters) {
        return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
        AGENT_WAITERS_BY_RUN_ID.delete(runId);
    }
}
function addWaiter(runId, waiter) {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
        return () => { };
    }
    const existing = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
    if (existing) {
        existing.add(waiter);
        return () => removeWaiter(normalizedRunId, waiter);
    }
    AGENT_WAITERS_BY_RUN_ID.set(normalizedRunId, new Set([waiter]));
    return () => removeWaiter(normalizedRunId, waiter);
}
function notifyWaiters(runId) {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
        return;
    }
    const waiters = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
    if (!waiters || waiters.size === 0) {
        return;
    }
    for (const waiter of waiters) {
        waiter();
    }
}
export function readTerminalSnapshotFromDedupeEntry(entry) {
    const payload = entry.payload;
    const status = typeof payload?.status === "string" ? payload.status : undefined;
    if (status === "accepted" || status === "started" || status === "in_flight") {
        return null;
    }
    const startedAt = asFiniteNumber(payload?.startedAt);
    const endedAt = asFiniteNumber(payload?.endedAt) ?? entry.ts;
    const errorMessage = typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.summary === "string"
            ? payload.summary
            : entry.error?.message;
    if (status === "ok" || status === "timeout") {
        return {
            status,
            startedAt,
            endedAt,
            error: status === "timeout" ? errorMessage : undefined,
        };
    }
    if (status === "error" || !entry.ok) {
        return {
            status: "error",
            startedAt,
            endedAt,
            error: errorMessage,
        };
    }
    return null;
}
export function readTerminalSnapshotFromGatewayDedupe(params) {
    if (params.ignoreAgentTerminalSnapshot) {
        const chatEntry = params.dedupe.get(`chat:${params.runId}`);
        if (!chatEntry) {
            return null;
        }
        return readTerminalSnapshotFromDedupeEntry(chatEntry);
    }
    const chatEntry = params.dedupe.get(`chat:${params.runId}`);
    const chatSnapshot = chatEntry ? readTerminalSnapshotFromDedupeEntry(chatEntry) : null;
    const agentEntry = params.dedupe.get(`agent:${params.runId}`);
    const agentSnapshot = agentEntry ? readTerminalSnapshotFromDedupeEntry(agentEntry) : null;
    if (agentEntry) {
        if (!agentSnapshot) {
            // If agent is still in-flight, only trust chat if it was written after
            // this agent entry (indicating a newer completed chat run reused runId).
            if (chatSnapshot && chatEntry && chatEntry.ts > agentEntry.ts) {
                return chatSnapshot;
            }
            return null;
        }
    }
    if (agentSnapshot && chatSnapshot && agentEntry && chatEntry) {
        // Reused idempotency keys can leave both records present. Prefer the
        // freshest terminal snapshot so callers observe the latest run outcome.
        return chatEntry.ts > agentEntry.ts ? chatSnapshot : agentSnapshot;
    }
    return agentSnapshot ?? chatSnapshot;
}
export async function waitForTerminalGatewayDedupe(params) {
    const initial = readTerminalSnapshotFromGatewayDedupe(params);
    if (initial) {
        return initial;
    }
    if (params.timeoutMs <= 0 || params.signal?.aborted) {
        return null;
    }
    return await new Promise((resolve) => {
        let settled = false;
        let timeoutHandle;
        let onAbort;
        let removeWaiter;
        const finish = (snapshot) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            if (onAbort) {
                params.signal?.removeEventListener("abort", onAbort);
            }
            removeWaiter?.();
            resolve(snapshot);
        };
        const onWake = () => {
            const snapshot = readTerminalSnapshotFromGatewayDedupe(params);
            if (snapshot) {
                finish(snapshot);
            }
        };
        removeWaiter = addWaiter(params.runId, onWake);
        onWake();
        if (settled) {
            return;
        }
        timeoutHandle = setSafeTimeout(() => finish(null), params.timeoutMs);
        timeoutHandle.unref?.();
        onAbort = () => finish(null);
        params.signal?.addEventListener("abort", onAbort, { once: true });
    });
}
export function setGatewayDedupeEntry(params) {
    params.dedupe.set(params.key, params.entry);
    const runId = parseRunIdFromDedupeKey(params.key);
    if (!runId) {
        return;
    }
    const snapshot = readTerminalSnapshotFromDedupeEntry(params.entry);
    if (!snapshot) {
        return;
    }
    notifyWaiters(runId);
}
export const __testing = {
    getWaiterCount(runId) {
        if (runId) {
            return AGENT_WAITERS_BY_RUN_ID.get(runId)?.size ?? 0;
        }
        let total = 0;
        for (const waiters of AGENT_WAITERS_BY_RUN_ID.values()) {
            total += waiters.size;
        }
        return total;
    },
    resetWaiters() {
        AGENT_WAITERS_BY_RUN_ID.clear();
    },
};
