import { ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { danger } from "../../globals.js";
import { wrapFetchWithAbortSignal } from "../../infra/fetch.js";
import type { RuntimeEnv } from "../../runtime.js";

let globalProxySet = false;

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
    if (!globalProxySet) {
      setGlobalDispatcher(agent);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        return originalFetch(input, {
          ...init,
          // @ts-expect-error - undici dispatcher option
          dispatcher: agent,
        });
      }) as typeof fetch;
      globalProxySet = true;
      runtime.log?.("discord: rest proxy enabled (global fetch patched)");
    }
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
    return wrapFetchWithAbortSignal(fetcher);
  } catch (err) {
    runtime.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
    return fetch;
  }
}
