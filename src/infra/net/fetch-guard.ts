import type { Dispatcher } from "undici";
import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "./ssrf.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GuardedFetchOptions = {
  url: string;
  fetchImpl?: FetchLike;
  init?: RequestInit;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  policy?: SsrFPolicy;
  lookupFn?: LookupFn;
  pinDns?: boolean;
  /** HTTP/HTTPS proxy URL. If not provided, reads from HTTP_PROXY/HTTPS_PROXY env vars. */
  proxyUrl?: string;
  /** Set to true to disable automatic proxy detection from environment. */
  noProxy?: boolean;
};

export type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
};

const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Check if a hostname should bypass the proxy based on NO_PROXY/no_proxy.
 * Supports comma-separated hostnames and wildcard prefixes (e.g., ".example.com").
 */
function shouldBypassProxy(hostname: string): boolean {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (!noProxy) {
    return false;
  }
  const entries = noProxy.split(",").map((s) => s.trim().toLowerCase());
  const lowerHost = hostname.toLowerCase();
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") return true;
    if (entry === lowerHost) return true;
    if (entry.startsWith(".") && lowerHost.endsWith(entry)) return true;
    if (lowerHost.endsWith("." + entry)) return true;
  }
  return false;
}

/**
 * Resolve proxy URL from options or environment variables.
 *
 * Precedence:
 * - If noProxy option is true, returns undefined
 * - If explicit proxyUrl option is provided, uses that
 * - Checks NO_PROXY/no_proxy to see if hostname should bypass proxy
 * - For HTTPS: HTTPS_PROXY → https_proxy → HTTP_PROXY → http_proxy
 * - For HTTP: HTTP_PROXY → http_proxy → HTTPS_PROXY → https_proxy
 */
function resolveProxyUrl(params: {
  proxyUrl?: string;
  noProxy?: boolean;
  protocol?: string;
  hostname?: string;
}): string | undefined {
  if (params.noProxy) {
    return undefined;
  }
  if (params.proxyUrl) {
    return params.proxyUrl;
  }
  // Check NO_PROXY before using environment proxy
  if (params.hostname && shouldBypassProxy(params.hostname)) {
    return undefined;
  }
  // Check environment variables (protocol-specific first, then fallback)
  const isHttps = params.protocol === "https:";
  if (isHttps) {
    return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  }
  return process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function buildAbortSignal(params: { timeoutMs?: number; signal?: AbortSignal }): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const { timeoutMs, signal } = params;
  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup: () => {} };
  }

  if (!timeoutMs) {
    return { signal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
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

export async function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const fetcher: FetchLike | undefined = params.fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("fetch is not available");
  }

  const maxRedirects =
    typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects)
      ? Math.max(0, Math.floor(params.maxRedirects))
      : DEFAULT_MAX_REDIRECTS;

  const { signal, cleanup } = buildAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  let released = false;
  const release = async (dispatcher?: Dispatcher | null) => {
    if (released) {
      return;
    }
    released = true;
    cleanup();
    await closeDispatcher(dispatcher ?? undefined);
  };

  const visited = new Set<string>();
  let currentUrl = params.url;
  let redirectCount = 0;

  while (true) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }

    let dispatcher: Dispatcher | null = null;
    try {
      const usePolicy = Boolean(
        params.policy?.allowPrivateNetwork || params.policy?.allowedHostnames?.length,
      );
      const pinned = usePolicy
        ? await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
            lookupFn: params.lookupFn,
            policy: params.policy,
          })
        : await resolvePinnedHostname(parsedUrl.hostname, params.lookupFn);
      if (params.pinDns !== false) {
        const proxyUrl = resolveProxyUrl({
          proxyUrl: params.proxyUrl,
          noProxy: params.noProxy,
          protocol: parsedUrl.protocol,
          hostname: parsedUrl.hostname,
        });
        dispatcher = createPinnedDispatcher(pinned, { proxyUrl });
      }

      const init: RequestInit & { dispatcher?: Dispatcher } = {
        ...(params.init ? { ...params.init } : {}),
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
        const nextUrl = new URL(location, parsedUrl).toString();
        if (visited.has(nextUrl)) {
          await release(dispatcher);
          throw new Error("Redirect loop detected");
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
    } catch (err) {
      await release(dispatcher);
      throw err;
    }
  }
}
