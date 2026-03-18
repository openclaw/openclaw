import { ProxyAgent, fetch as undiciFetch } from "undici";
import { danger } from "../../globals.js";
import { wrapFetchWithAbortSignal } from "../../infra/fetch.js";
import {
  isProxyCircuitOpen,
  isProxyConnectError,
  recordProxyFailure,
  recordProxySuccess,
} from "../../infra/net/proxy-probe.js";
import type { RuntimeEnv } from "../../runtime.js";

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
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isProxyCircuitOpen(proxy)) {
        return fetch(input, init);
      }
      try {
        const response = await undiciFetch(input as string | URL, {
          ...(init as Record<string, unknown>),
          dispatcher: agent,
        });
        recordProxySuccess(proxy);
        return response as unknown as Response;
      } catch (err) {
        if (isProxyConnectError(err)) {
          recordProxyFailure(proxy);
          return fetch(input, init);
        }
        throw err;
      }
    }) as typeof fetch;
    runtime.log?.("discord: rest proxy enabled");
    return wrapFetchWithAbortSignal(fetcher);
  } catch (err) {
    runtime.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
    return fetch;
  }
}
