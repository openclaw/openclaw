import { AUTH_RATE_LIMIT_SCOPE_DEFAULT, normalizeRateLimitClientIp } from "./auth-rate-limit.js";
const pendingAttempts = new Map();
function normalizeScope(scope) {
    return (scope ?? AUTH_RATE_LIMIT_SCOPE_DEFAULT).trim() || AUTH_RATE_LIMIT_SCOPE_DEFAULT;
}
function buildSerializationKey(ip, scope) {
    return `${normalizeScope(scope)}:${normalizeRateLimitClientIp(ip)}`;
}
export async function withSerializedRateLimitAttempt(params) {
    const key = buildSerializationKey(params.ip, params.scope);
    const previous = pendingAttempts.get(key) ?? Promise.resolve();
    let releaseCurrent;
    const current = new Promise((resolve) => {
        releaseCurrent = resolve;
    });
    const tail = previous.catch(() => { }).then(() => current);
    pendingAttempts.set(key, tail);
    await previous.catch(() => { });
    try {
        return await params.run();
    }
    finally {
        releaseCurrent();
        if (pendingAttempts.get(key) === tail) {
            pendingAttempts.delete(key);
        }
    }
}
