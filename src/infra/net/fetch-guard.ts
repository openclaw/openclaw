import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { logWarn } from "../../logger.js";
import { bindAbortRelay } from "../../utils/fetch-timeout.js";
import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  SsrFBlockedError,
  type SsrFPolicy,
} from "./ssrf.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GuardedFetchOptions = {
  url: string;
  fetchImpl?: FetchLike;
  init?: RequestInit;
  maxRedirects?: number;
  pinnedHostname?: string;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  auditContext?: string;
};

export type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
};

/**
 * Check if SOCKS5 proxy is configured in environment variables.
 * undici's EnvHttpProxyAgent doesn't support SOCKS5 protocol.
 */
function hasSocks5ProxyConfigured(): boolean {
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const allProxy = process.env.ALL_PROXY || process.env.all_proxy;

  const proxyUrl = httpProxy || httpsProxy || allProxy;

  if (proxyUrl) {
    try {
      const url = new URL(proxyUrl);
      if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
        return true;
      }
    } catch {
      // Invalid URL, ignore
    }
  }

  return false;
}

/**
 * Create proxy agent with SOCKS5 detection.
 * Returns null if SOCKS5 is detected (not supported by undici).
 */
function createProxyAgent(): Dispatcher | null {
  if (hasSocks5ProxyConfigured()) {
    logWarn(
      "fetch-guard: SOCKS5 proxy detected but not supported by undici. " +
      "Please configure an HTTP or HTTPS proxy instead. " +
      "Request will be made without proxy."
    );
    return null;
  }

  try {
    return new EnvHttpProxyAgent() as unknown as Dispatcher;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Check if the error is related to SOCKS5 or unsupported protocol
    if (errorMessage.toLowerCase().includes("socks5") || 
        errorMessage.toLowerCase().includes("protocol") ||
        errorMessage.toLowerCase().includes("unsupported")) {
      logWarn(
        `fetch-guard: Proxy configuration not supported: ${errorMessage}. ` +
        "Request will be made without proxy."
      );
      return null;
    }

    // Re-throw other errors
    throw err;
  }
}

function stripSensitiveHeadersForCrossOriginRedirect(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("www-authenticate");
  return { ...init, headers };
}

function release(dispatcher: Dispatcher | undefined): Promise<void> {
  if (!dispatcher) {
    return Promise.resolve();
  }
  return closeDispatcher(dispatcher).catch(() => {});
}

export function guardedFetch(): (params: GuardedFetchOptions) => Promise<GuardedFetchResult> {
  return async function fetchGuarded(
    params: GuardedFetchOptions,
  ): Promise<GuardedFetchResult> {
    const {
      url,
      fetchImpl = fetch,
      init = {},
      maxRedirects = 10,
      pinnedHostname,
      ssrfPolicy,
      lookupFn,
    } = params;

    const parsedUrl = new URL(url);

    if (ssrfPolicy) {
      const resolved = await resolvePinnedHostnameWithPolicy({
        parsedUrl,
        ssrfPolicy,
        lookupFn,
      });
      if (resolved.pinnedHostname) {
        Object.assign(parsedUrl, { hostname: resolved.pinnedHostname });
      }
    } else if (pinnedHostname) {
      Object.assign(parsedUrl, { hostname: pinnedHostname });
    }

    let currentUrl = parsedUrl.toString();
    let currentInit = init;
    const visited = new Set<string>([currentUrl]);

    for (let redirectCount = 0; redirectCount < maxRedirects; redirectCount++) {
      let dispatcher: Dispatcher | undefined;

      try {
        // Create proxy agent with SOCKS5 detection
        dispatcher = createProxyAgent() ?? undefined;

        if (ssrfPolicy && dispatcher) {
          const pinnedDispatcher = await createPinnedDispatcher({
            parsedUrl: new URL(currentUrl),
            ssrfPolicy,
            lookupFn,
            underlyingAgent: dispatcher,
          });
          dispatcher = pinnedDispatcher;
        }

        const fetchOptions: RequestInit = {
          ...currentInit,
          dispatcher,
        };

        bindAbortRelay(currentInit, fetchOptions);

        const response = await fetchImpl(currentUrl, fetchOptions);

        if (![301, 302, 303, 307, 308].includes(response.status)) {
          return {
            response,
            finalUrl: currentUrl,
            release: async () => release(dispatcher),
          };
        }

        const location = response.headers.get("location");
        if (!location) {
          await release(dispatcher);
          throw new Error(`Redirect ${response.status} without location header`);
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
      } catch (err) {
        if (err instanceof SsrFBlockedError) {
          const context = params.auditContext ?? "url-fetch";
          logWarn(
            `security: blocked URL fetch (${context}) target=${parsedUrl.origin}${parsedUrl.pathname} reason=${err.message}`,
          );
        }
        await release(dispatcher);
        throw err;
      }
    }

    throw new Error(`Maximum redirects (${maxRedirects}) exceeded`);
  };
}

// CI trigger: Updated to fix SOCKS5 proxy handling
