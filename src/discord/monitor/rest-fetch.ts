import { ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { danger } from "../../globals.js";
import { wrapFetchWithAbortSignal } from "../../infra/fetch.js";
import type { RuntimeEnv } from "../../runtime.js";

let globalProxyApplied = false;

/**
 * Apply global proxy dispatcher for undici.
 * This ensures all fetch requests (including @buape/carbon's internal REST client)
 * use the configured proxy.
 */
export function applyDiscordGlobalProxy(proxyUrl: string | undefined, runtime: RuntimeEnv): void {
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return;
  }
  if (globalProxyApplied) {
    return;
  }
  try {
    const agent = new ProxyAgent(proxy);
    setGlobalDispatcher(agent);
    globalProxyApplied = true;
    runtime.log?.("discord: global rest proxy enabled");
  } catch (err) {
    runtime.error?.(danger(`discord: failed to set global proxy: ${String(err)}`));
  }
}

export function resolveDiscordRestFetch(
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): typeof fetch {
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return fetch;
  }
  try {
    const agent = new ProxyAgent(proxy);
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
    runtime.log?.("discord: rest proxy enabled");
    return wrapFetchWithAbortSignal(fetcher);
  } catch (err) {
    runtime.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
    return fetch;
  }
}
