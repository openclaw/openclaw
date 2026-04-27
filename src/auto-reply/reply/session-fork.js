/**
 * Default max parent token count beyond which thread/session parent forking is skipped.
 * This prevents new thread sessions from inheriting near-full parent context.
 * See #26905.
 */
const DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000;
let sessionForkRuntimePromise = null;
function loadSessionForkRuntime() {
    sessionForkRuntimePromise ??= import("./session-fork.runtime.js");
    return sessionForkRuntimePromise;
}
export function resolveParentForkMaxTokens(cfg) {
    const configured = cfg.session?.parentForkMaxTokens;
    if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) {
        return Math.floor(configured);
    }
    return DEFAULT_PARENT_FORK_MAX_TOKENS;
}
export async function forkSessionFromParent(params) {
    const runtime = await loadSessionForkRuntime();
    return runtime.forkSessionFromParentRuntime(params);
}
export async function resolveParentForkTokenCount(params) {
    const runtime = await loadSessionForkRuntime();
    return runtime.resolveParentForkTokenCountRuntime(params);
}
