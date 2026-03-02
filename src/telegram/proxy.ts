import process from "node:process";
import { ProxyAgent, fetch as undiciFetch } from "undici";

export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  // Keep proxy dispatching request-scoped. Replacing the global dispatcher breaks
  // env-driven HTTP(S)_PROXY behavior for unrelated outbound requests.
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>) as typeof fetch;
  // Return raw proxy fetch; call sites that need AbortSignal normalization
  // should opt into resolveFetch/wrapFetchWithAbortSignal once at the edge.
  return fetcher;
}

/**
 * Resolve the proxy URL from config or standard environment variables.
 * Priority: explicit config > HTTPS_PROXY > HTTP_PROXY (case-insensitive).
 */
export function resolveProxyUrl(configProxy?: string): string | undefined {
  const explicit = configProxy?.trim();
  if (explicit) {
    return explicit;
  }
  return (
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    undefined
  );
}
