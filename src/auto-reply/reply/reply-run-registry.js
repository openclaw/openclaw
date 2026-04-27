import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");
const replyRunState = resolveGlobalSingleton(REPLY_RUN_STATE_KEY, () => ({
    activeRunsByKey: new Map(),
    activeSessionIdsByKey: new Map(),
    activeKeysBySessionId: new Map(),
    waitKeysBySessionId: new Map(),
    waitersByKey: new Map(),
}));
export class ReplyRunAlreadyActiveError extends Error {
    constructor(sessionKey) {
        super(`Reply run already active for ${sessionKey}`);
        this.name = "ReplyRunAlreadyActiveError";
    }
}
function createUserAbortError() {
    const err = new Error("Reply operation aborted by user");
    err.name = "AbortError";
    return err;
}
function registerWaitSessionId(sessionKey, sessionId) {
    replyRunState.waitKeysBySessionId.set(sessionId, sessionKey);
}
function clearWaitSessionIds(sessionKey) {
    for (const [sessionId, mappedKey] of replyRunState.waitKeysBySessionId) {
        if (mappedKey === sessionKey) {
            replyRunState.waitKeysBySessionId.delete(sessionId);
        }
    }
}
function notifyReplyRunEnded(sessionKey) {
    const waiters = replyRunState.waitersByKey.get(sessionKey);
    if (!waiters || waiters.size === 0) {
        return;
    }
    replyRunState.waitersByKey.delete(sessionKey);
    for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(true);
    }
}
function resolveReplyRunForCurrentSessionId(sessionId) {
    const normalizedSessionId = normalizeOptionalString(sessionId);
    if (!normalizedSessionId) {
        return undefined;
    }
    const sessionKey = replyRunState.activeKeysBySessionId.get(normalizedSessionId);
    if (!sessionKey) {
        return undefined;
    }
    return replyRunState.activeRunsByKey.get(sessionKey);
}
function resolveReplyRunWaitKey(sessionId) {
    const normalizedSessionId = normalizeOptionalString(sessionId);
    if (!normalizedSessionId) {
        return undefined;
    }
    return (replyRunState.activeKeysBySessionId.get(normalizedSessionId) ??
        replyRunState.waitKeysBySessionId.get(normalizedSessionId));
}
function isReplyRunCompacting(operation) {
    if (operation.phase === "preflight_compacting" || operation.phase === "memory_flushing") {
        return true;
    }
    if (operation.phase !== "running") {
        return false;
    }
    const backend = getAttachedBackend(operation);
    return backend?.isCompacting?.() ?? false;
}
const attachedBackendByOperation = new WeakMap();
function getAttachedBackend(operation) {
    return attachedBackendByOperation.get(operation);
}
function clearReplyRunState(params) {
    replyRunState.activeRunsByKey.delete(params.sessionKey);
    if (replyRunState.activeSessionIdsByKey.get(params.sessionKey) === params.sessionId) {
        replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
    }
    else {
        replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
    }
    if (replyRunState.activeKeysBySessionId.get(params.sessionId) === params.sessionKey) {
        replyRunState.activeKeysBySessionId.delete(params.sessionId);
    }
    clearWaitSessionIds(params.sessionKey);
    notifyReplyRunEnded(params.sessionKey);
}
export function createReplyOperation(params) {
    const sessionKey = normalizeOptionalString(params.sessionKey);
    const sessionId = normalizeOptionalString(params.sessionId);
    if (!sessionKey) {
        throw new Error("Reply operations require a canonical sessionKey");
    }
    if (!sessionId) {
        throw new Error("Reply operations require a sessionId");
    }
    if (replyRunState.activeRunsByKey.has(sessionKey)) {
        throw new ReplyRunAlreadyActiveError(sessionKey);
    }
    const controller = new AbortController();
    let currentSessionId = sessionId;
    let phase = "queued";
    let result = null;
    let stateCleared = false;
    const clearState = () => {
        if (stateCleared) {
            return;
        }
        stateCleared = true;
        clearReplyRunState({
            sessionKey,
            sessionId: currentSessionId,
        });
    };
    const abortInternally = (reason) => {
        if (!controller.signal.aborted) {
            controller.abort(reason);
        }
    };
    const abortWithReason = (reason, abortReason, opts) => {
        if (opts?.abortedCode && !result) {
            result = { kind: "aborted", code: opts.abortedCode };
        }
        phase = "aborted";
        abortInternally(abortReason);
        getAttachedBackend(operation)?.cancel(reason);
    };
    if (params.upstreamAbortSignal) {
        if (params.upstreamAbortSignal.aborted) {
            abortInternally(params.upstreamAbortSignal.reason);
        }
        else {
            params.upstreamAbortSignal.addEventListener("abort", () => {
                abortInternally(params.upstreamAbortSignal?.reason);
            }, { once: true });
        }
    }
    const operation = {
        get key() {
            return sessionKey;
        },
        get sessionId() {
            return currentSessionId;
        },
        get abortSignal() {
            return controller.signal;
        },
        get resetTriggered() {
            return params.resetTriggered;
        },
        get phase() {
            return phase;
        },
        get result() {
            return result;
        },
        setPhase(next) {
            if (result) {
                return;
            }
            phase = next;
        },
        updateSessionId(nextSessionId) {
            if (result) {
                return;
            }
            const normalizedNextSessionId = normalizeOptionalString(nextSessionId);
            if (!normalizedNextSessionId || normalizedNextSessionId === currentSessionId) {
                return;
            }
            if (replyRunState.activeKeysBySessionId.has(normalizedNextSessionId) &&
                replyRunState.activeKeysBySessionId.get(normalizedNextSessionId) !== sessionKey) {
                throw new Error(`Cannot rebind reply operation ${sessionKey} to active session ${normalizedNextSessionId}`);
            }
            replyRunState.activeKeysBySessionId.delete(currentSessionId);
            registerWaitSessionId(sessionKey, currentSessionId);
            currentSessionId = normalizedNextSessionId;
            replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
            replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
            registerWaitSessionId(sessionKey, currentSessionId);
        },
        attachBackend(handle) {
            if (result) {
                handle.cancel(result.kind === "aborted"
                    ? result.code === "aborted_for_restart"
                        ? "restart"
                        : "user_abort"
                    : "superseded");
                return;
            }
            attachedBackendByOperation.set(operation, handle);
            if (controller.signal.aborted) {
                handle.cancel("superseded");
            }
        },
        detachBackend(handle) {
            if (getAttachedBackend(operation) === handle) {
                attachedBackendByOperation.delete(operation);
            }
        },
        complete() {
            if (!result) {
                result = { kind: "completed" };
                phase = "completed";
            }
            clearState();
        },
        fail(code, cause) {
            if (!result) {
                result = { kind: "failed", code, cause };
                phase = "failed";
            }
            clearState();
        },
        abortByUser() {
            const phaseBeforeAbort = phase;
            abortWithReason("user_abort", createUserAbortError(), {
                abortedCode: "aborted_by_user",
            });
            if (phaseBeforeAbort === "queued") {
                clearState();
            }
        },
        abortForRestart() {
            const phaseBeforeAbort = phase;
            abortWithReason("restart", new Error("Reply operation aborted for restart"), {
                abortedCode: "aborted_for_restart",
            });
            if (phaseBeforeAbort === "queued") {
                clearState();
            }
        },
    };
    replyRunState.activeRunsByKey.set(sessionKey, operation);
    replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
    replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
    registerWaitSessionId(sessionKey, currentSessionId);
    return operation;
}
export const replyRunRegistry = {
    begin(params) {
        return createReplyOperation(params);
    },
    get(sessionKey) {
        const normalizedSessionKey = normalizeOptionalString(sessionKey);
        if (!normalizedSessionKey) {
            return undefined;
        }
        return replyRunState.activeRunsByKey.get(normalizedSessionKey);
    },
    isActive(sessionKey) {
        const normalizedSessionKey = normalizeOptionalString(sessionKey);
        if (!normalizedSessionKey) {
            return false;
        }
        return replyRunState.activeRunsByKey.has(normalizedSessionKey);
    },
    isStreaming(sessionKey) {
        const operation = this.get(sessionKey);
        if (!operation || operation.phase !== "running") {
            return false;
        }
        return getAttachedBackend(operation)?.isStreaming() ?? false;
    },
    abort(sessionKey) {
        const operation = this.get(sessionKey);
        if (!operation) {
            return false;
        }
        operation.abortByUser();
        return true;
    },
    waitForIdle(sessionKey, timeoutMs = 15_000) {
        const normalizedSessionKey = normalizeOptionalString(sessionKey);
        if (!normalizedSessionKey || !replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            const waiters = replyRunState.waitersByKey.get(normalizedSessionKey) ?? new Set();
            const waiter = {
                resolve,
                timer: setTimeout(() => {
                    waiters.delete(waiter);
                    if (waiters.size === 0) {
                        replyRunState.waitersByKey.delete(normalizedSessionKey);
                    }
                    resolve(false);
                }, Math.max(100, timeoutMs)),
            };
            waiters.add(waiter);
            replyRunState.waitersByKey.set(normalizedSessionKey, waiters);
            if (!replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
                waiters.delete(waiter);
                if (waiters.size === 0) {
                    replyRunState.waitersByKey.delete(normalizedSessionKey);
                }
                clearTimeout(waiter.timer);
                resolve(true);
            }
        });
    },
    resolveSessionId(sessionKey) {
        const normalizedSessionKey = normalizeOptionalString(sessionKey);
        if (!normalizedSessionKey) {
            return undefined;
        }
        return replyRunState.activeSessionIdsByKey.get(normalizedSessionKey);
    },
};
export function resolveActiveReplyRunSessionId(sessionKey) {
    return replyRunRegistry.resolveSessionId(sessionKey);
}
export function isReplyRunActiveForSessionId(sessionId) {
    return resolveReplyRunForCurrentSessionId(sessionId) !== undefined;
}
export function isReplyRunStreamingForSessionId(sessionId) {
    const operation = resolveReplyRunForCurrentSessionId(sessionId);
    if (!operation || operation.phase !== "running") {
        return false;
    }
    return getAttachedBackend(operation)?.isStreaming() ?? false;
}
export function queueReplyRunMessage(sessionId, text) {
    const operation = resolveReplyRunForCurrentSessionId(sessionId);
    const backend = operation ? getAttachedBackend(operation) : undefined;
    if (!operation || operation.phase !== "running" || !backend?.queueMessage) {
        return false;
    }
    if (!backend.isStreaming()) {
        return false;
    }
    void backend.queueMessage(text);
    return true;
}
export function abortReplyRunBySessionId(sessionId) {
    const operation = resolveReplyRunForCurrentSessionId(sessionId);
    if (!operation) {
        return false;
    }
    operation.abortByUser();
    return true;
}
export function waitForReplyRunEndBySessionId(sessionId, timeoutMs = 15_000) {
    const waitKey = resolveReplyRunWaitKey(sessionId);
    if (!waitKey) {
        return Promise.resolve(true);
    }
    return replyRunRegistry.waitForIdle(waitKey, timeoutMs);
}
export function abortActiveReplyRuns(opts) {
    let aborted = false;
    for (const operation of replyRunState.activeRunsByKey.values()) {
        if (opts.mode === "compacting" && !isReplyRunCompacting(operation)) {
            continue;
        }
        operation.abortForRestart();
        aborted = true;
    }
    return aborted;
}
export function getActiveReplyRunCount() {
    return replyRunState.activeRunsByKey.size;
}
export function listActiveReplyRunSessionIds() {
    return [...replyRunState.activeSessionIdsByKey.values()];
}
export const __testing = {
    resetReplyRunRegistry() {
        replyRunState.activeRunsByKey.clear();
        replyRunState.activeSessionIdsByKey.clear();
        replyRunState.activeKeysBySessionId.clear();
        replyRunState.waitKeysBySessionId.clear();
        for (const waiters of replyRunState.waitersByKey.values()) {
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                waiter.resolve(false);
            }
        }
        replyRunState.waitersByKey.clear();
    },
};
