import { ProxyAgent, fetch as undiciFetch } from "undici";
export function makeProxyFetch(proxyUrl) {
    const agent = new ProxyAgent(proxyUrl);
    // undici's fetch is runtime-compatible with global fetch but the types diverge
    // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
    // Keep proxy dispatching request-scoped. Replacing the global dispatcher breaks
    // env-driven HTTP(S)_PROXY behavior for unrelated outbound requests.
    const fetcher = ((input, init) => undiciFetch(input, {
        ...init,
        dispatcher: agent,
    }));
    // Return raw proxy fetch; call sites that need AbortSignal normalization
    // should opt into resolveFetch/wrapFetchWithAbortSignal once at the edge.
    return fetcher;
}
