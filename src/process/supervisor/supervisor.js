import crypto from "node:crypto";
import { getShellConfig } from "../../agents/shell-utils.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createChildAdapter } from "./adapters/child.js";
import { createPtyAdapter } from "./adapters/pty.js";
import { createRunRegistry } from "./registry.js";
const log = createSubsystemLogger("process/supervisor");
function clampTimeout(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.max(1, Math.floor(value));
}
function isTimeoutReason(reason) {
    return reason === "overall-timeout" || reason === "no-output-timeout";
}
export function createProcessSupervisor() {
    const registry = createRunRegistry();
    const active = new Map();
    const cancel = (runId, reason = "manual-cancel") => {
        const current = active.get(runId);
        if (!current) {
            return;
        }
        registry.updateState(runId, "exiting", {
            terminationReason: reason,
        });
        current.run.cancel(reason);
    };
    const cancelScope = (scopeKey, reason = "manual-cancel") => {
        if (!scopeKey.trim()) {
            return;
        }
        for (const [runId, run] of active.entries()) {
            if (run.scopeKey !== scopeKey) {
                continue;
            }
            cancel(runId, reason);
        }
    };
    const spawn = async (input) => {
        const runId = input.runId?.trim() || crypto.randomUUID();
        if (input.replaceExistingScope && input.scopeKey?.trim()) {
            cancelScope(input.scopeKey, "manual-cancel");
        }
        const startedAtMs = Date.now();
        const record = {
            runId,
            sessionId: input.sessionId,
            backendId: input.backendId,
            scopeKey: input.scopeKey?.trim() || undefined,
            state: "starting",
            startedAtMs,
            lastOutputAtMs: startedAtMs,
            createdAtMs: startedAtMs,
            updatedAtMs: startedAtMs,
        };
        registry.add(record);
        let forcedReason = null;
        let settled = false;
        let stdout = "";
        let stderr = "";
        let timeoutTimer = null;
        let noOutputTimer = null;
        const captureOutput = input.captureOutput !== false;
        const overallTimeoutMs = clampTimeout(input.timeoutMs);
        const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);
        const setForcedReason = (reason) => {
            if (forcedReason) {
                return;
            }
            forcedReason = reason;
            registry.updateState(runId, "exiting", { terminationReason: reason });
        };
        let cancelAdapter = null;
        const requestCancel = (reason) => {
            setForcedReason(reason);
            cancelAdapter?.(reason);
        };
        const touchOutput = () => {
            registry.touchOutput(runId);
            if (!noOutputTimeoutMs || settled) {
                return;
            }
            if (noOutputTimer) {
                clearTimeout(noOutputTimer);
            }
            noOutputTimer = setTimeout(() => {
                requestCancel("no-output-timeout");
            }, noOutputTimeoutMs);
        };
        try {
            if (input.mode === "child" && input.argv.length === 0) {
                throw new Error("spawn argv cannot be empty");
            }
            const adapter = input.mode === "pty"
                ? await (async () => {
                    const { shell, args: shellArgs } = getShellConfig();
                    const ptyCommand = input.ptyCommand.trim();
                    if (!ptyCommand) {
                        throw new Error("PTY command cannot be empty");
                    }
                    return await createPtyAdapter({
                        shell,
                        args: [...shellArgs, ptyCommand],
                        cwd: input.cwd,
                        env: input.env,
                    });
                })()
                : await createChildAdapter({
                    argv: input.argv,
                    cwd: input.cwd,
                    env: input.env,
                    windowsVerbatimArguments: input.windowsVerbatimArguments,
                    input: input.input,
                    stdinMode: input.stdinMode,
                });
            registry.updateState(runId, "running", { pid: adapter.pid });
            const clearTimers = () => {
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = null;
                }
                if (noOutputTimer) {
                    clearTimeout(noOutputTimer);
                    noOutputTimer = null;
                }
            };
            cancelAdapter = (_reason) => {
                if (settled) {
                    return;
                }
                adapter.kill("SIGKILL");
            };
            if (overallTimeoutMs) {
                timeoutTimer = setTimeout(() => {
                    requestCancel("overall-timeout");
                }, overallTimeoutMs);
            }
            if (noOutputTimeoutMs) {
                noOutputTimer = setTimeout(() => {
                    requestCancel("no-output-timeout");
                }, noOutputTimeoutMs);
            }
            adapter.onStdout((chunk) => {
                if (captureOutput) {
                    stdout += chunk;
                }
                input.onStdout?.(chunk);
                touchOutput();
            });
            adapter.onStderr((chunk) => {
                if (captureOutput) {
                    stderr += chunk;
                }
                input.onStderr?.(chunk);
                touchOutput();
            });
            const waitPromise = (async () => {
                const result = await adapter.wait();
                if (settled) {
                    return {
                        reason: forcedReason ?? "exit",
                        exitCode: result.code,
                        exitSignal: result.signal,
                        durationMs: Date.now() - startedAtMs,
                        stdout,
                        stderr,
                        timedOut: isTimeoutReason(forcedReason ?? "exit"),
                        noOutputTimedOut: forcedReason === "no-output-timeout",
                    };
                }
                settled = true;
                clearTimers();
                adapter.dispose();
                active.delete(runId);
                const reason = forcedReason ?? (result.signal != null ? "signal" : "exit");
                const exit = {
                    reason,
                    exitCode: result.code,
                    exitSignal: result.signal,
                    durationMs: Date.now() - startedAtMs,
                    stdout,
                    stderr,
                    timedOut: isTimeoutReason(forcedReason ?? reason),
                    noOutputTimedOut: forcedReason === "no-output-timeout",
                };
                registry.finalize(runId, {
                    reason: exit.reason,
                    exitCode: exit.exitCode,
                    exitSignal: exit.exitSignal,
                });
                return exit;
            })().catch((err) => {
                if (!settled) {
                    settled = true;
                    clearTimers();
                    active.delete(runId);
                    adapter.dispose();
                    registry.finalize(runId, {
                        reason: "spawn-error",
                        exitCode: null,
                        exitSignal: null,
                    });
                }
                throw err;
            });
            const managedRun = {
                runId,
                pid: adapter.pid,
                startedAtMs,
                stdin: adapter.stdin,
                wait: async () => await waitPromise,
                cancel: (reason = "manual-cancel") => {
                    requestCancel(reason);
                },
            };
            active.set(runId, {
                run: managedRun,
                scopeKey: input.scopeKey?.trim() || undefined,
            });
            return managedRun;
        }
        catch (err) {
            registry.finalize(runId, {
                reason: "spawn-error",
                exitCode: null,
                exitSignal: null,
            });
            log.warn(`spawn failed: runId=${runId} reason=${String(err)}`);
            throw err;
        }
    };
    return {
        spawn,
        cancel,
        cancelScope,
        reconcileOrphans: async () => {
            // Deliberate no-op: this supervisor uses in-memory ownership only.
            // Active runs are not recovered after process restart in the current model.
        },
        getRecord: (runId) => registry.get(runId),
    };
}
