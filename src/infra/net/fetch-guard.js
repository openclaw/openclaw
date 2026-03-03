import { EnvHttpProxyAgent } from "undici";
import { logWarn } from "../../logger.js";
import { bindAbortRelay } from "../../utils/fetch-timeout.js";
import { hasProxyEnvConfigured } from "./proxy-env.js";
import { closeDispatcher, createPinnedDispatcher, resolvePinnedHostnameWithPolicy, SsrFBlockedError, } from "./ssrf.js";
export const GUARDED_FETCH_MODE = {
    STRICT: "strict",
    TRUSTED_ENV_PROXY: "trusted_env_proxy",
};
const DEFAULT_MAX_REDIRECTS = 3;
const CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "cookie2",
];
export function withStrictGuardedFetchMode(params) {
    return { ...params, mode: GUARDED_FETCH_MODE.STRICT };
}
export function withTrustedEnvProxyGuardedFetchMode(params) {
    return { ...params, mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY };
}
function resolveGuardedFetchMode(params) {
    if (params.mode) {
        return params.mode;
    }
    if (params.proxy === "env" && params.dangerouslyAllowEnvProxyWithoutPinnedDns === true) {
        return GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY;
    }
    return GUARDED_FETCH_MODE.STRICT;
}
function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function stripSensitiveHeadersForCrossOriginRedirect(init) {
    if (!init?.headers) {
        return init;
    }
    const headers = new Headers(init.headers);
    for (const header of CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS) {
        headers.delete(header);
    }
    return { ...init, headers };
}
function buildAbortSignal(params) {
    const { timeoutMs, signal } = params;
    if (!timeoutMs && !signal) {
        return { signal: undefined, cleanup: () => { } };
    }
    if (!timeoutMs) {
        return { signal, cleanup: () => { } };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
    const onAbort = bindAbortRelay(controller);
    if (signal) {
        if (signal.aborted) {
            controller.abort();
        }
        else {
            signal.addEventListener("abort", onAbort, { once: true });
        }
    }
    const cleanup = () => {
        clearTimeout(timeoutId);
        if (signal) {
            signal.removeEventListener("abort", onAbort);
        }
    };
    return { signal: controller.signal, cleanup };
}
export async function fetchWithSsrFGuard(params) {
    const fetcher = params.fetchImpl ?? globalThis.fetch;
    if (!fetcher) {
        throw new Error("fetch is not available");
    }
    const maxRedirects = typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects)
        ? Math.max(0, Math.floor(params.maxRedirects))
        : DEFAULT_MAX_REDIRECTS;
    const mode = resolveGuardedFetchMode(params);
    const { signal, cleanup } = buildAbortSignal({
        timeoutMs: params.timeoutMs,
        signal: params.signal,
    });
    let released = false;
    const release = async (dispatcher) => {
        if (released) {
            return;
        }
        released = true;
        cleanup();
        await closeDispatcher(dispatcher ?? undefined);
    };
    const visited = new Set();
    let currentUrl = params.url;
    let currentInit = params.init ? { ...params.init } : undefined;
    let redirectCount = 0;
    while (true) {
        let parsedUrl;
        try {
            parsedUrl = new URL(currentUrl);
        }
        catch {
            await release();
            throw new Error("Invalid URL: must be http or https");
        }
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
            await release();
            throw new Error("Invalid URL: must be http or https");
        }
        let dispatcher = null;
        try {
            const pinned = await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
                lookupFn: params.lookupFn,
                policy: params.policy,
            });
            const canUseTrustedEnvProxy = mode === GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY && hasProxyEnvConfigured();
            if (canUseTrustedEnvProxy) {
                dispatcher = new EnvHttpProxyAgent();
            }
            else if (params.pinDns !== false) {
                dispatcher = createPinnedDispatcher(pinned);
            }
            const init = {
                ...(currentInit ? { ...currentInit } : {}),
                redirect: "manual",
                ...(dispatcher ? { dispatcher } : {}),
                ...(signal ? { signal } : {}),
            };
            const response = await fetcher(parsedUrl.toString(), init);
            if (isRedirectStatus(response.status)) {
                const location = response.headers.get("location");
                if (!location) {
                    await release(dispatcher);
                    throw new Error(`Redirect missing location header (${response.status})`);
                }
                redirectCount += 1;
                if (redirectCount > maxRedirects) {
                    await release(dispatcher);
                    throw new Error(`Too many redirects (limit: ${maxRedirects})`);
                }
                const nextParsedUrl = new URL(location, parsedUrl);
                const nextUrl = nextParsedUrl.toString();
                if (visited.has(nextUrl)) {
                    await release(dispatcher);
                    throw new Error("Redirect loop detected");
                }
                if (nextParsedUrl.origin !== parsedUrl.origin) {
                    currentInit = stripSensitiveHeadersForCrossOriginRedirect(currentInit);
                }
                visited.add(nextUrl);
                void response.body?.cancel();
                await closeDispatcher(dispatcher);
                currentUrl = nextUrl;
                continue;
            }
            return {
                response,
                finalUrl: currentUrl,
                release: async () => release(dispatcher),
            };
        }
        catch (err) {
            if (err instanceof SsrFBlockedError) {
                const context = params.auditContext ?? "url-fetch";
                logWarn(`security: blocked URL fetch (${context}) target=${parsedUrl.origin}${parsedUrl.pathname} reason=${err.message}`);
            }
            await release(dispatcher);
            throw err;
        }
    }
}
