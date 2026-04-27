import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { logWarn } from "../../logger.js";
import { formatErrorMessage } from "../errors.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";
export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export function makeProxyFetch(proxyUrl) {
    let agent = null;
    const resolveAgent = () => {
        if (!agent) {
            agent = new ProxyAgent(proxyUrl);
        }
        return agent;
    };
    // undici's fetch is runtime-compatible with global fetch but the types diverge
    // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
    const proxyFetch = ((input, init) => undiciFetch(input, {
        ...init,
        dispatcher: resolveAgent(),
    }));
    Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
        value: proxyUrl,
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return proxyFetch;
}
export function getProxyUrlFromFetch(fetchImpl) {
    const proxyUrl = fetchImpl?.[PROXY_FETCH_PROXY_URL];
    if (typeof proxyUrl !== "string") {
        return undefined;
    }
    const trimmed = proxyUrl.trim();
    return trimmed ? trimmed : undefined;
}
/**
 * Resolve a proxy-aware fetch from standard environment variables
 * (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(env = process.env) {
    if (!hasEnvHttpProxyConfigured("https", env)) {
        return undefined;
    }
    try {
        const agent = new EnvHttpProxyAgent();
        return ((input, init) => undiciFetch(input, {
            ...init,
            dispatcher: agent,
        }));
    }
    catch (err) {
        logWarn(`Proxy env var set but agent creation failed — falling back to direct fetch: ${formatErrorMessage(err)}`);
        return undefined;
    }
}
