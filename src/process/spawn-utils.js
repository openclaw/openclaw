import { spawn } from "node:child_process";
const DEFAULT_RETRY_CODES = ["EBADF"];
export function resolveCommandStdio(params) {
    const stdin = params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe";
    return [stdin, "pipe", "pipe"];
}
export function formatSpawnError(err) {
    if (!(err instanceof Error)) {
        return String(err);
    }
    const details = err;
    const parts = [];
    const message = err.message?.trim();
    if (message) {
        parts.push(message);
    }
    if (details.code && !message?.includes(details.code)) {
        parts.push(details.code);
    }
    if (details.syscall) {
        parts.push(`syscall=${details.syscall}`);
    }
    if (typeof details.errno === "number") {
        parts.push(`errno=${details.errno}`);
    }
    return parts.join(" ");
}
function shouldRetry(err, codes) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    return code.length > 0 && codes.includes(code);
}
async function spawnAndWaitForSpawn(spawnImpl, argv, options) {
    const child = spawnImpl(argv[0], argv.slice(1), options);
    return await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            child.removeListener("error", onError);
            child.removeListener("spawn", onSpawn);
        };
        const finishResolve = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(child);
        };
        const onError = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(err);
        };
        const onSpawn = () => {
            finishResolve();
        };
        child.once("error", onError);
        child.once("spawn", onSpawn);
        // Ensure mocked spawns that never emit "spawn" don't stall.
        process.nextTick(() => {
            if (typeof child.pid === "number") {
                finishResolve();
            }
        });
    });
}
export async function spawnWithFallback(params) {
    const spawnImpl = params.spawnImpl ?? spawn;
    const retryCodes = params.retryCodes ?? DEFAULT_RETRY_CODES;
    const baseOptions = { ...params.options };
    const fallbacks = params.fallbacks ?? [];
    const attempts = [
        { options: baseOptions },
        ...fallbacks.map((fallback) => ({
            label: fallback.label,
            options: { ...baseOptions, ...fallback.options },
        })),
    ];
    let lastError;
    for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        try {
            const child = await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt.options);
            return {
                child,
                usedFallback: index > 0,
                fallbackLabel: attempt.label,
            };
        }
        catch (err) {
            lastError = err;
            const nextFallback = fallbacks[index];
            if (!nextFallback || !shouldRetry(err, retryCodes)) {
                throw err;
            }
            params.onFallback?.(err, nextFallback);
        }
    }
    throw lastError;
}
