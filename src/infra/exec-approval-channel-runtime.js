import { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
function resolveApprovalReplayMethods(eventKinds) {
    const methods = [];
    if (eventKinds.has("exec")) {
        methods.push("exec.approval.list");
    }
    if (eventKinds.has("plugin")) {
        methods.push("plugin.approval.list");
    }
    return methods;
}
export function createExecApprovalChannelRuntime(adapter) {
    const log = createSubsystemLogger(adapter.label);
    const nowMs = adapter.nowMs ?? Date.now;
    const eventKinds = new Set(adapter.eventKinds ?? ["exec"]);
    const pending = new Map();
    let gatewayClient = null;
    let started = false;
    let shouldRun = false;
    let startPromise = null;
    let replayPromise = null;
    const shouldKeepRunning = () => shouldRun;
    const spawn = (label, promise) => {
        void promise.catch((err) => {
            const message = formatErrorMessage(err);
            log.error(`${label}: ${message}`);
        });
    };
    const stopClientIfInactive = (client) => {
        if (shouldKeepRunning()) {
            return false;
        }
        gatewayClient = null;
        client.stop();
        return true;
    };
    const clearPendingEntry = (approvalId) => {
        const entry = pending.get(approvalId);
        if (!entry) {
            return null;
        }
        pending.delete(approvalId);
        if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
        }
        return entry;
    };
    const handleExpired = async (approvalId) => {
        const entry = clearPendingEntry(approvalId);
        if (!entry) {
            return;
        }
        log.debug(`expired ${approvalId}`);
        await adapter.finalizeExpired?.({
            request: entry.request,
            entries: entry.entries,
        });
    };
    const handleRequested = async (request, opts) => {
        if (opts?.ignoreIfInactive && !shouldKeepRunning()) {
            return;
        }
        if (!adapter.shouldHandle(request)) {
            return;
        }
        if (pending.has(request.id)) {
            log.debug(`ignored duplicate request ${request.id}`);
            return;
        }
        log.debug(`received request ${request.id}`);
        const entry = {
            request,
            entries: [],
            timeoutId: null,
            delivering: true,
            pendingResolution: null,
        };
        pending.set(request.id, entry);
        let entries;
        try {
            entries = await adapter.deliverRequested(request);
        }
        catch (err) {
            if (pending.get(request.id) === entry) {
                clearPendingEntry(request.id);
            }
            throw err;
        }
        const current = pending.get(request.id);
        if (current !== entry) {
            return;
        }
        if (!entries.length) {
            pending.delete(request.id);
            return;
        }
        entry.entries = entries;
        entry.delivering = false;
        if (entry.pendingResolution) {
            pending.delete(request.id);
            log.debug(`resolved ${entry.pendingResolution.id} with ${entry.pendingResolution.decision}`);
            await adapter.finalizeResolved({
                request: entry.request,
                resolved: entry.pendingResolution,
                entries: entry.entries,
            });
            return;
        }
        const timeoutMs = Math.max(0, request.expiresAtMs - nowMs());
        const timeoutId = setTimeout(() => {
            spawn("error handling approval expiration", handleExpired(request.id));
        }, timeoutMs);
        timeoutId.unref?.();
        entry.timeoutId = timeoutId;
    };
    const handleResolved = async (resolved) => {
        const entry = pending.get(resolved.id);
        if (!entry) {
            return;
        }
        if (entry.delivering) {
            entry.pendingResolution = resolved;
            return;
        }
        const finalizedEntry = clearPendingEntry(resolved.id);
        if (!finalizedEntry) {
            return;
        }
        log.debug(`resolved ${resolved.id} with ${resolved.decision}`);
        await adapter.finalizeResolved({
            request: finalizedEntry.request,
            resolved,
            entries: finalizedEntry.entries,
        });
    };
    const handleGatewayEvent = (evt) => {
        if (evt.event === "exec.approval.requested" && eventKinds.has("exec")) {
            spawn("error handling approval request", handleRequested(evt.payload, { ignoreIfInactive: true }));
            return;
        }
        if (evt.event === "plugin.approval.requested" && eventKinds.has("plugin")) {
            spawn("error handling approval request", handleRequested(evt.payload, { ignoreIfInactive: true }));
            return;
        }
        if (evt.event === "exec.approval.resolved" && eventKinds.has("exec")) {
            spawn("error handling approval resolved", handleResolved(evt.payload));
            return;
        }
        if (evt.event === "plugin.approval.resolved" && eventKinds.has("plugin")) {
            spawn("error handling approval resolved", handleResolved(evt.payload));
        }
    };
    const replayPendingApprovals = async (client) => {
        try {
            for (const method of resolveApprovalReplayMethods(eventKinds)) {
                if (stopClientIfInactive(client)) {
                    return;
                }
                const pendingRequests = await client.request(method, {});
                if (stopClientIfInactive(client)) {
                    return;
                }
                for (const request of pendingRequests) {
                    if (stopClientIfInactive(client)) {
                        return;
                    }
                    await handleRequested(request, { ignoreIfInactive: true });
                }
            }
        }
        catch (error) {
            if (!shouldKeepRunning()) {
                return;
            }
            throw error;
        }
    };
    const startPendingApprovalReplay = (client) => {
        const promise = replayPendingApprovals(client)
            .catch((err) => {
            const message = formatErrorMessage(err);
            log.error(`error replaying pending approvals: ${message}`);
        })
            .finally(() => {
            if (replayPromise === promise) {
                replayPromise = null;
            }
        });
        replayPromise = promise;
    };
    const waitForPendingApprovalReplay = async () => {
        const replay = replayPromise;
        if (!replay) {
            return;
        }
        await replay.catch(() => { });
    };
    return {
        async start() {
            if (started) {
                return;
            }
            if (startPromise) {
                await startPromise;
                return;
            }
            shouldRun = true;
            startPromise = (async () => {
                if (!adapter.isConfigured()) {
                    log.debug("disabled");
                    return;
                }
                let readySettled = false;
                let resolveReady;
                let rejectReady;
                const ready = new Promise((resolve, reject) => {
                    resolveReady = resolve;
                    rejectReady = reject;
                });
                const settleReady = (fn) => {
                    if (readySettled) {
                        return;
                    }
                    readySettled = true;
                    fn();
                };
                const client = await createOperatorApprovalsGatewayClient({
                    config: adapter.cfg,
                    gatewayUrl: adapter.gatewayUrl,
                    clientDisplayName: adapter.clientDisplayName,
                    onEvent: handleGatewayEvent,
                    onHelloOk: () => {
                        log.debug("connected to gateway");
                        settleReady(resolveReady);
                    },
                    onConnectError: (err) => {
                        log.error(`connect error: ${err.message}`);
                        settleReady(() => rejectReady(err));
                    },
                    onClose: (code, reason) => {
                        log.debug(`gateway closed: ${code} ${reason}`);
                        settleReady(() => rejectReady(new Error(`gateway closed: ${code} ${reason}`)));
                    },
                });
                if (!shouldRun) {
                    client.stop();
                    return;
                }
                await adapter.beforeGatewayClientStart?.();
                gatewayClient = client;
                try {
                    client.start();
                    await ready;
                    if (stopClientIfInactive(client)) {
                        return;
                    }
                    started = true;
                    startPendingApprovalReplay(client);
                }
                catch (error) {
                    gatewayClient = null;
                    started = false;
                    client.stop();
                    throw error;
                }
            })().finally(() => {
                startPromise = null;
            });
            await startPromise;
        },
        async stop() {
            shouldRun = false;
            if (startPromise) {
                await startPromise.catch(() => { });
            }
            const wasActive = started || gatewayClient !== null || replayPromise !== null;
            started = false;
            gatewayClient?.stop();
            gatewayClient = null;
            await waitForPendingApprovalReplay();
            if (!wasActive) {
                await adapter.onStopped?.();
                return;
            }
            for (const entry of pending.values()) {
                if (entry.timeoutId) {
                    clearTimeout(entry.timeoutId);
                }
            }
            pending.clear();
            await adapter.onStopped?.();
            log.debug("stopped");
        },
        handleRequested,
        handleResolved,
        handleExpired,
        async request(method, params) {
            if (!gatewayClient) {
                throw new Error(`${adapter.label}: gateway client not connected`);
            }
            return (await gatewayClient.request(method, params));
        },
    };
}
