// @ts-nocheck
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { wrapFetchWithAbortSignal } from "../infra/fetch.js";
import { createSocksDispatcher, isSocksProxyUrl } from "../infra/net/socks-dispatcher.js";

export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = isSocksProxyUrl(proxyUrl)
    ? createSocksDispatcher(proxyUrl)
    : new ProxyAgent(proxyUrl);
  return wrapFetchWithAbortSignal((input: RequestInfo | URL, init?: RequestInit) => {
    const base = init ? { ...init } : {};
    return undiciFetch(input, { ...base, dispatcher: agent });
  });
}
