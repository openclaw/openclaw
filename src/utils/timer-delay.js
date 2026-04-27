export const MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647;
export function resolveSafeTimeoutDelayMs(delayMs, opts) {
    const rawMinMs = opts?.minMs ?? 1;
    const minMs = Math.min(MAX_SAFE_TIMEOUT_DELAY_MS, Math.max(0, Number.isFinite(rawMinMs) ? Math.floor(rawMinMs) : 1));
    const candidateMs = Number.isFinite(delayMs) ? Math.floor(delayMs) : minMs;
    return Math.min(MAX_SAFE_TIMEOUT_DELAY_MS, Math.max(minMs, candidateMs));
}
export function setSafeTimeout(callback, delayMs, opts) {
    return setTimeout(callback, resolveSafeTimeoutDelayMs(delayMs, opts));
}
