import { ProxyAgent, fetch as undiciFetch } from "undici";
import { danger } from "../../globals.js";
import { wrapFetchWithAbortSignal } from "../../infra/fetch.js";
export function resolveDiscordRestFetch(proxyUrl, runtime) {
    const proxy = proxyUrl?.trim();
    if (!proxy) {
        return fetch;
    }
    try {
        const agent = new ProxyAgent(proxy);
        const fetcher = ((input, init) => undiciFetch(input, {
            ...init,
            dispatcher: agent,
        }));
        runtime.log?.("discord: rest proxy enabled");
        return wrapFetchWithAbortSignal(fetcher);
    }
    catch (err) {
        runtime.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
        return fetch;
    }
}
