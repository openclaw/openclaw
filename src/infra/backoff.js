import { setTimeout as delay } from "node:timers/promises";
export function computeBackoff(policy, attempt) {
    const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
    const jitter = base * policy.jitter * Math.random();
    return Math.min(policy.maxMs, Math.round(base + jitter));
}
export async function sleepWithAbort(ms, abortSignal) {
    if (ms <= 0) {
        return;
    }
    try {
        await delay(ms, undefined, { signal: abortSignal });
    }
    catch (err) {
        if (abortSignal?.aborted) {
            throw new Error("aborted", { cause: err });
        }
        throw err;
    }
}
