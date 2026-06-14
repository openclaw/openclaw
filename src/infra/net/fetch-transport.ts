// App-owned fetch transport for web/media/download paths.
import type { Dispatcher } from "undici";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";
import {
  normalizeHeadersInitForFetch,
  normalizeRequestInitHeadersForFetch,
} from "../fetch-headers.js";
import { retainSafeHeadersForCrossOriginRedirect as retainSafeRedirectHeaders } from "./redirect-headers.js";
import {
  fetchWithRuntimeDispatcher,
  isMockedFetch,
  type DispatcherAwareRequestInit,
} from "./runtime-fetch.js";
import { closeDispatcher, type PinnedDispatcherPolicy } from "./ssrf.js";
import { globalUndiciStreamTimeoutMs } from "./undici-global-dispatcher.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "./undici-runtime.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AppFetchUrlValidationContext = {
  redirectCount: number;
};

export type AppFetchRedirectContext = {
  redirectCount: number;
  status: number;
  fromUrl: string;
  location: string;
};

export type AppFetchTransportOptions = {
  url: string;
  fetchImpl?: FetchLike;
  init?: RequestInit;
  maxRedirects?: number;
  allowCrossOriginUnsafeRedirectReplay?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  requireHttps?: boolean;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  validateUrl?: (url: URL, context: AppFetchUrlValidationContext) => void;
  onRedirect?: (url: URL, context: AppFetchRedirectContext) => void;
};

export type AppFetchTransportResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
  refreshTimeout?: () => void;
};

const DEFAULT_MAX_REDIRECTS = 3;

function resolveDispatcherTimeoutMs(fromParams: number | undefined): number | undefined {
  if (fromParams !== undefined) {
    return fromParams;
  }
  if (globalUndiciStreamTimeoutMs !== undefined) {
    return globalUndiciStreamTimeoutMs;
  }
  return undefined;
}

function getRedirectVisitKey(url: string, init: RequestInit | undefined): string {
  return `${init?.method?.toUpperCase() ?? "GET"} ${url}`;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isManagedProxyActive(): boolean {
  return process.env["OPENCLAW_PROXY_ACTIVE"] === "1";
}

function isAmbientGlobalFetch(params: {
  fetchImpl: FetchLike | undefined;
  globalFetch: FetchLike | undefined;
}): boolean {
  return (
    typeof params.fetchImpl === "function" &&
    typeof params.globalFetch === "function" &&
    params.fetchImpl === params.globalFetch
  );
}

function dropBodyHeaders(headers?: HeadersInit): HeadersInit | undefined {
  if (!headers) {
    return headers;
  }
  const nextHeaders = new Headers(normalizeHeadersInitForFetch(headers));
  nextHeaders.delete("content-encoding");
  nextHeaders.delete("content-language");
  nextHeaders.delete("content-length");
  nextHeaders.delete("content-location");
  nextHeaders.delete("content-type");
  nextHeaders.delete("transfer-encoding");
  return nextHeaders;
}

function rewriteRedirectInitForMethod(params: {
  init?: RequestInit;
  status: number;
}): RequestInit | undefined {
  const { init, status } = params;
  if (!init) {
    return init;
  }

  const currentMethod = init.method?.toUpperCase() ?? "GET";
  const shouldForceGet =
    status === 303
      ? currentMethod !== "GET" && currentMethod !== "HEAD"
      : (status === 301 || status === 302) && currentMethod === "POST";

  if (!shouldForceGet) {
    return init;
  }

  return {
    ...init,
    method: "GET",
    body: undefined,
    headers: dropBodyHeaders(init.headers),
  };
}

function rewriteRedirectInitForCrossOrigin(params: {
  init?: RequestInit;
  allowUnsafeReplay: boolean;
}): RequestInit | undefined {
  const { init, allowUnsafeReplay } = params;
  if (!init || allowUnsafeReplay) {
    return init;
  }

  const currentMethod = init.method?.toUpperCase() ?? "GET";
  if (currentMethod === "GET" || currentMethod === "HEAD") {
    return init;
  }

  return {
    ...init,
    method: "GET",
    body: undefined,
    headers: dropBodyHeaders(init.headers),
  };
}

function retainSafeHeadersForCrossOriginRedirect(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) {
    return init;
  }
  return { ...init, headers: retainSafeRedirectHeaders(init.headers) };
}

function validateExplicitProxyUrl(proxyUrl: string): void {
  let parsedProxyUrl: URL;
  try {
    parsedProxyUrl = new URL(proxyUrl);
  } catch {
    throw new Error("Invalid explicit proxy URL");
  }
  if (!["http:", "https:"].includes(parsedProxyUrl.protocol)) {
    throw new Error("Explicit proxy URL must use http or https");
  }
}

function createPolicyDispatcher(
  dispatcherPolicy: PinnedDispatcherPolicy | undefined,
  timeoutMs?: number,
): Dispatcher | null {
  if (!dispatcherPolicy || isManagedProxyActive()) {
    return null;
  }

  if (dispatcherPolicy.mode === "direct") {
    return createHttp1Agent(
      dispatcherPolicy.connect ? { connect: { ...dispatcherPolicy.connect } } : undefined,
      timeoutMs,
    );
  }

  if (dispatcherPolicy.mode === "env-proxy") {
    return createHttp1EnvHttpProxyAgent(
      {
        ...(dispatcherPolicy.connect ? { connect: { ...dispatcherPolicy.connect } } : {}),
        ...(dispatcherPolicy.proxyTls ? { proxyTls: { ...dispatcherPolicy.proxyTls } } : {}),
      },
      timeoutMs,
    );
  }

  const proxyUrl = dispatcherPolicy.proxyUrl.trim();
  validateExplicitProxyUrl(proxyUrl);
  if (dispatcherPolicy.proxyTls) {
    return createHttp1ProxyAgent(
      { uri: proxyUrl, requestTls: { ...dispatcherPolicy.proxyTls } },
      timeoutMs,
    );
  }
  return createHttp1ProxyAgent({ uri: proxyUrl }, timeoutMs);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup while replacing a redirect/error response.
  }
}

export async function fetchWithAppNetworkTransport(
  params: AppFetchTransportOptions,
): Promise<AppFetchTransportResult> {
  const defaultFetch: FetchLike | undefined = params.fetchImpl ?? globalThis.fetch;
  if (!defaultFetch) {
    throw new Error("fetch is not available");
  }
  const isUsingMockedFetch = isMockedFetch(defaultFetch);

  const maxRedirects =
    typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects)
      ? Math.max(0, Math.floor(params.maxRedirects))
      : DEFAULT_MAX_REDIRECTS;

  const { signal, cleanup, refresh } = buildTimeoutAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    operation: "fetchWithAppNetworkTransport",
    url: params.url,
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

  let currentUrl = params.url;
  let currentInit = normalizeRequestInitHeadersForFetch(
    params.init ? { ...params.init } : undefined,
  );
  const visited = new Set<string>([getRedirectVisitKey(currentUrl, currentInit)]);
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
    if (params.requireHttps === true && parsedUrl.protocol !== "https:") {
      await release();
      throw new Error("URL must use https");
    }
    try {
      params.validateUrl?.(parsedUrl, { redirectCount });
    } catch (err) {
      await release();
      throw err;
    }

    let dispatcher: Dispatcher | null = null;
    try {
      dispatcher = createPolicyDispatcher(
        params.dispatcherPolicy,
        resolveDispatcherTimeoutMs(params.timeoutMs),
      );
      const init: DispatcherAwareRequestInit = {
        ...(currentInit ? { ...currentInit } : {}),
        redirect: "manual",
        ...(dispatcher ? { dispatcher } : {}),
        ...(signal ? { signal } : {}),
      };
      const supportsDispatcherInit =
        (params.fetchImpl !== undefined &&
          !isAmbientGlobalFetch({
            fetchImpl: params.fetchImpl,
            globalFetch: globalThis.fetch,
          })) ||
        isUsingMockedFetch;
      const shouldUseRuntimeFetch = Boolean(dispatcher) && !supportsDispatcherInit;
      const response = shouldUseRuntimeFetch
        ? await fetchWithRuntimeDispatcher(parsedUrl.toString(), init)
        : await defaultFetch(parsedUrl.toString(), init);

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          await cancelResponseBody(response);
          await release(dispatcher);
          throw new Error(`Redirect missing location header (${response.status})`);
        }
        redirectCount += 1;
        const nextParsedUrl = new URL(location, parsedUrl);
        try {
          params.onRedirect?.(nextParsedUrl, {
            redirectCount,
            status: response.status,
            fromUrl: parsedUrl.toString(),
            location,
          });
        } catch (err) {
          await cancelResponseBody(response);
          await release(dispatcher);
          throw err;
        }
        if (redirectCount > maxRedirects) {
          await cancelResponseBody(response);
          await release(dispatcher);
          throw new Error(`Too many redirects (limit: ${maxRedirects})`);
        }
        const nextUrl = nextParsedUrl.toString();
        currentInit = rewriteRedirectInitForMethod({ init: currentInit, status: response.status });
        if (nextParsedUrl.origin !== parsedUrl.origin) {
          currentInit = rewriteRedirectInitForCrossOrigin({
            init: currentInit,
            allowUnsafeReplay: params.allowCrossOriginUnsafeRedirectReplay === true,
          });
          currentInit = retainSafeHeadersForCrossOriginRedirect(currentInit);
        }
        const nextVisitKey = getRedirectVisitKey(nextUrl, currentInit);
        if (visited.has(nextVisitKey)) {
          await cancelResponseBody(response);
          await release(dispatcher);
          throw new Error("Redirect loop detected");
        }
        visited.add(nextVisitKey);
        await cancelResponseBody(response);
        await closeDispatcher(dispatcher);
        currentUrl = nextUrl;
        continue;
      }

      return {
        response,
        finalUrl: currentUrl,
        release: async () => release(dispatcher),
        refreshTimeout: refresh,
      };
    } catch (err) {
      await release(dispatcher);
      throw err;
    }
  }
}
