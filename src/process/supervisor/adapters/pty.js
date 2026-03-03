import { killProcessTree } from "../../kill-tree.js";
import { toStringEnv } from "./env.js";
const FORCE_KILL_WAIT_FALLBACK_MS = 4000;
export async function createPtyAdapter(params) {
    const module = (await import("@lydell/node-pty"));
    const spawn = module.spawn ?? module.default?.spawn;
    if (!spawn) {
        throw new Error("PTY support is unavailable (node-pty spawn not found).");
    }
    const pty = spawn(params.shell, params.args, {
        cwd: params.cwd,
        env: params.env ? toStringEnv(params.env) : undefined,
        name: params.name ?? process.env.TERM ?? "xterm-256color",
        cols: params.cols ?? 120,
        rows: params.rows ?? 30,
    });
    let dataListener = null;
    let exitListener = null;
    let waitResult = null;
    let resolveWait = null;
    let waitPromise = null;
    let forceKillWaitFallbackTimer = null;
    const clearForceKillWaitFallback = () => {
        if (!forceKillWaitFallbackTimer) {
            return;
        }
        clearTimeout(forceKillWaitFallbackTimer);
        forceKillWaitFallbackTimer = null;
    };
    const settleWait = (value) => {
        if (waitResult) {
            return;
        }
        clearForceKillWaitFallback();
        waitResult = value;
        if (resolveWait) {
            const resolve = resolveWait;
            resolveWait = null;
            resolve(value);
        }
    };
    const scheduleForceKillWaitFallback = (signal) => {
        clearForceKillWaitFallback();
        // Some PTY hosts fail to emit onExit after kill; use a delayed fallback
        // so callers can still unblock without marking termination immediately.
        forceKillWaitFallbackTimer = setTimeout(() => {
            settleWait({ code: null, signal });
        }, FORCE_KILL_WAIT_FALLBACK_MS);
        forceKillWaitFallbackTimer.unref();
    };
    exitListener =
        pty.onExit((event) => {
            const signal = event.signal && event.signal !== 0 ? event.signal : null;
            settleWait({ code: event.exitCode ?? null, signal });
        }) ?? null;
    const stdin = {
        destroyed: false,
        write: (data, cb) => {
            try {
                pty.write(data);
                cb?.(null);
            }
            catch (err) {
                cb?.(err);
            }
        },
        end: () => {
            try {
                const eof = process.platform === "win32" ? "\x1a" : "\x04";
                pty.write(eof);
            }
            catch {
                // ignore EOF errors
            }
        },
    };
    const onStdout = (listener) => {
        dataListener =
            pty.onData((chunk) => {
                listener(chunk.toString());
            }) ?? null;
    };
    const onStderr = (_listener) => {
        // PTY gives a unified output stream.
    };
    const wait = async () => {
        if (waitResult) {
            return waitResult;
        }
        if (!waitPromise) {
            waitPromise = new Promise((resolve) => {
                resolveWait = resolve;
                if (waitResult) {
                    const settled = waitResult;
                    resolveWait = null;
                    resolve(settled);
                }
            });
        }
        return waitPromise;
    };
    const kill = (signal = "SIGKILL") => {
        try {
            if (signal === "SIGKILL" && typeof pty.pid === "number" && pty.pid > 0) {
                killProcessTree(pty.pid);
            }
            else if (process.platform === "win32") {
                pty.kill();
            }
            else {
                pty.kill(signal);
            }
        }
        catch {
            // ignore kill errors
        }
        if (signal === "SIGKILL") {
            scheduleForceKillWaitFallback(signal);
        }
    };
    const dispose = () => {
        try {
            dataListener?.dispose();
        }
        catch {
            // ignore disposal errors
        }
        try {
            exitListener?.dispose();
        }
        catch {
            // ignore disposal errors
        }
        clearForceKillWaitFallback();
        dataListener = null;
        exitListener = null;
        settleWait({ code: null, signal: null });
    };
    return {
        pid: pty.pid || undefined,
        stdin,
        onStdout,
        onStderr,
        wait,
        kill,
        dispose,
    };
}
