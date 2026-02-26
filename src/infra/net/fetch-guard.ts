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
  timeoutMs?: number;
  signal?: AbortSignal;
  policy?: SsrFPolicy;
  lookupFn?: LookupFn;
  pinDns?: boolean;
  proxy?: "env";
  auditContext?: string;
};

export type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
};

const DEFAULT_MAX_REDIRECTS = 3;
const ENV_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
];

function hasEnvProxyConfigured(): boolean {
  for (const key of ENV_PROXY_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return true;
    }
  }
  return false;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function stripSensitiveHeadersForCrossOriginRedirect(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) {
    return init;
  }
  const headers = new Headers(init.headers);
  for (const header of CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS) {
    headers.delete(header);
  }
  return { ...init, headers };
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
  const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
  const onAbort = bindAbortRelay(controller);
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
  let currentInit = params.init ? { ...params.init } : undefined;
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
      const pinned = await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
        lookupFn: params.lookupFn,
        policy: params.policy,
      });
      if (params.proxy === "env" && hasEnvProxyConfigured()) {
        dispatcher = new EnvHttpProxyAgent();
      } else if (params.pinDns !== false) {
        dispatcher = createPinnedDispatcher(pinned);
      }

      const init: RequestInit & { dispatcher?: Dispatcher } = {
        ...(currentInit ? { ...currentInit } : {}),
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
      }

      return {
        response,
        finalUrl: currentUrl,
        release: async () => release(dispatcher),
      };
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
}
