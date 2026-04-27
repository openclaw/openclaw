import { killProcessTree } from "../../kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../../linux-oom-score.js";
import { spawnWithFallback } from "../../spawn-utils.js";
import { resolveWindowsCommandShim } from "../../windows-command.js";
import { toStringEnv } from "./env.js";
const FORCE_KILL_WAIT_FALLBACK_MS = 4000;
const WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS = 250;
function resolveCommand(command) {
    return resolveWindowsCommandShim({
        command,
        cmdCommands: ["npm", "pnpm", "yarn", "npx"],
    });
}
function isServiceManagedRuntime() {
    return Boolean(process.env.OPENCLAW_SERVICE_MARKER?.trim());
}
export async function createChildAdapter(params) {
    const resolvedArgv = [...params.argv];
    resolvedArgv[0] = resolveCommand(resolvedArgv[0] ?? "");
    const baseEnv = params.env ? toStringEnv(params.env) : undefined;
    const preparedSpawn = prepareOomScoreAdjustedSpawn(resolvedArgv[0] ?? "", resolvedArgv.slice(1), {
        env: baseEnv,
    });
    const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");
    // In service-managed mode keep children attached so systemd/launchd can
    // stop the full process tree reliably. Outside service mode preserve the
    // existing POSIX detached behavior.
    const useDetached = process.platform !== "win32" && !isServiceManagedRuntime();
    const options = {
        cwd: params.cwd,
        env: preparedSpawn.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: useDetached,
        windowsHide: true,
        windowsVerbatimArguments: params.windowsVerbatimArguments,
    };
    if (stdinMode === "inherit") {
        options.stdio = ["inherit", "pipe", "pipe"];
    }
    else {
        options.stdio = ["pipe", "pipe", "pipe"];
    }
    const spawned = await spawnWithFallback({
        argv: [preparedSpawn.command, ...preparedSpawn.args],
        options,
        fallbacks: useDetached
            ? [
                {
                    label: "no-detach",
                    options: { detached: false },
                },
            ]
            : [],
    });
    const child = spawned.child;
    if (child.stdin) {
        if (params.input !== undefined) {
            child.stdin.write(params.input);
            child.stdin.end();
        }
        else if (stdinMode === "pipe-closed") {
            child.stdin.end();
        }
    }
    const stdin = child.stdin
        ? {
            destroyed: false,
            write: (data, cb) => {
                try {
                    child.stdin.write(data, cb);
                }
                catch (err) {
                    cb?.(err);
                }
            },
            end: () => {
                try {
                    child.stdin.end();
                }
                catch {
                    // ignore close errors
                }
            },
            destroy: () => {
                try {
                    child.stdin.destroy();
                }
                catch {
                    // ignore destroy errors
                }
            },
        }
        : undefined;
    const onStdout = (listener) => {
        child.stdout.on("data", (chunk) => {
            listener(chunk.toString());
        });
    };
    const onStderr = (listener) => {
        child.stderr.on("data", (chunk) => {
            listener(chunk.toString());
        });
    };
    let waitResult = null;
    let waitError;
    let resolveWait = null;
    let rejectWait = null;
    let waitPromise = null;
    let forceKillWaitFallbackTimer = null;
    let childExitState = null;
    let windowsCloseFallbackTimer = null;
    let stdoutDrained = child.stdout == null;
    let stderrDrained = child.stderr == null;
    const clearForceKillWaitFallback = () => {
        if (!forceKillWaitFallbackTimer) {
            return;
        }
        clearTimeout(forceKillWaitFallbackTimer);
        forceKillWaitFallbackTimer = null;
    };
    const clearWindowsCloseFallbackTimer = () => {
        if (!windowsCloseFallbackTimer) {
            return;
        }
        clearTimeout(windowsCloseFallbackTimer);
        windowsCloseFallbackTimer = null;
    };
    const settleWait = (value) => {
        if (waitResult || waitError !== undefined) {
            return;
        }
        clearForceKillWaitFallback();
        clearWindowsCloseFallbackTimer();
        waitResult = value;
        if (resolveWait) {
            const resolve = resolveWait;
            resolveWait = null;
            rejectWait = null;
            resolve(value);
        }
    };
    const rejectPendingWait = (error) => {
        if (waitResult || waitError !== undefined) {
            return;
        }
        clearForceKillWaitFallback();
        clearWindowsCloseFallbackTimer();
        waitError = error;
        if (rejectWait) {
            const reject = rejectWait;
            resolveWait = null;
            rejectWait = null;
            reject(error);
        }
    };
    const scheduleForceKillWaitFallback = (signal) => {
        clearForceKillWaitFallback();
        // Some Windows child processes never emit `close` after a hard kill.
        forceKillWaitFallbackTimer = setTimeout(() => {
            settleWait({ code: null, signal });
        }, FORCE_KILL_WAIT_FALLBACK_MS);
        forceKillWaitFallbackTimer.unref?.();
    };
    const resolveObservedExitState = (fallback) => {
        if (childExitState != null) {
            return childExitState;
        }
        return {
            code: child.exitCode ?? fallback.code,
            signal: child.signalCode ?? fallback.signal,
        };
    };
    const maybeSettleAfterWindowsExit = () => {
        if (process.platform !== "win32" ||
            childExitState == null ||
            !stdoutDrained ||
            !stderrDrained) {
            return;
        }
        settleWait(resolveObservedExitState(childExitState));
    };
    const scheduleWindowsCloseFallback = () => {
        if (process.platform !== "win32") {
            return;
        }
        clearWindowsCloseFallbackTimer();
        windowsCloseFallbackTimer = setTimeout(() => {
            maybeSettleAfterWindowsExit();
        }, WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS);
        windowsCloseFallbackTimer.unref?.();
    };
    child.stdout?.once("end", () => {
        stdoutDrained = true;
        maybeSettleAfterWindowsExit();
    });
    child.stdout?.once("close", () => {
        stdoutDrained = true;
        maybeSettleAfterWindowsExit();
    });
    child.stderr?.once("end", () => {
        stderrDrained = true;
        maybeSettleAfterWindowsExit();
    });
    child.stderr?.once("close", () => {
        stderrDrained = true;
        maybeSettleAfterWindowsExit();
    });
    child.once("error", (error) => {
        rejectPendingWait(error);
    });
    child.once("exit", (code, signal) => {
        childExitState = { code, signal };
        scheduleWindowsCloseFallback();
    });
    child.once("close", (code, signal) => {
        settleWait(resolveObservedExitState({ code, signal }));
    });
    const wait = async () => {
        if (waitResult) {
            return waitResult;
        }
        if (waitError !== undefined) {
            throw waitError;
        }
        if (!waitPromise) {
            waitPromise = new Promise((resolve, reject) => {
                resolveWait = resolve;
                rejectWait = reject;
                if (waitResult) {
                    const settled = waitResult;
                    resolveWait = null;
                    rejectWait = null;
                    resolve(settled);
                    return;
                }
                if (waitError !== undefined) {
                    const error = waitError;
                    resolveWait = null;
                    rejectWait = null;
                    reject(error);
                }
            });
        }
        return waitPromise;
    };
    const kill = (signal) => {
        const pid = child.pid ?? undefined;
        if (signal === undefined || signal === "SIGKILL") {
            if (pid) {
                killProcessTree(pid);
            }
            try {
                child.kill("SIGKILL");
            }
            catch {
                // ignore kill errors
            }
            scheduleForceKillWaitFallback("SIGKILL");
            return;
        }
        try {
            child.kill(signal);
        }
        catch {
            // ignore kill errors for non-kill signals
        }
    };
    const dispose = () => {
        clearForceKillWaitFallback();
        clearWindowsCloseFallbackTimer();
        child.removeAllListeners();
    };
    return {
        pid: child.pid ?? undefined,
        stdin,
        onStdout,
        onStderr,
        wait,
        kill,
        dispose,
    };
}
