// Central HTTP egress runtime for app-owned fetch paths.
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import type { Dispatcher } from "undici";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";
import { normalizeHostname } from "./hostname.js";
import { shouldUseEnvHttpProxyForUrl } from "./proxy-env.js";
import { getActiveManagedProxyLoopbackMode } from "./proxy/active-proxy-state.js";
import { retainSafeHeadersForCrossOriginRedirect } from "./redirect-headers.js";
import {
  fetchWithRuntimeDispatcher,
  isMockedFetch,
  type DispatcherAwareRequestInit,
} from "./runtime-fetch.js";
import {
  closeDispatcher,
  createPinnedDispatcher,
  createPinnedLookup,
  isBlockedHostnameOrIp,
  type PinnedHostnameOverride,
  resolvePinnedHostnameWithPolicy,
  SsrFBlockedError,
  type LookupFn,
  type PinnedDispatcherPolicy,
  type SsrFPolicy,
} from "./ssrf.js";
import { globalUndiciStreamTimeoutMs } from "./undici-global-dispatcher.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "./undici-runtime.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type LookupResult = LookupAddress | LookupAddress[];

export type HttpEgressMode =
  | { kind: "operatorConfiguredEndpoint" }
  | {
      kind: "untrustedUrl";
      lookupFn?: LookupFn;
      proxyEnabled?: boolean;
      directPins?: Map<string, PinnedHostnameOverride>;
    };

export type FetchWithEgressPolicyOptions = {
  url: string;
  init?: DispatcherAwareRequestInit;
  fetchImpl?: FetchLike;
  followRedirects?: boolean;
  maxRedirects?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  operation?: string;
  mode?: HttpEgressMode;
  validateUrl?: (
    url: URL,
    context: { previousUrl?: URL; redirectCount: number },
  ) => void | Promise<void>;
  dispatcherPolicy?:
    | PinnedDispatcherPolicy
    | ((
        url: URL,
      ) => PinnedDispatcherPolicy | undefined | Promise<PinnedDispatcherPolicy | undefined>);
  useEnvProxy?: boolean;
  allowCrossOriginUnsafeRedirectReplay?: boolean;
  onResponse?: (params: {
    url: string;
    init: DispatcherAwareRequestInit;
    response: Response;
    capturedByGlobalFetchPatch: boolean;
    usingRuntimeFetch: boolean;
  }) => void | Promise<void>;
};

export type FetchWithResponseReleaseOptions = Omit<
  FetchWithEgressPolicyOptions,
  "mode" | "operation"
> & {
  operation?: string;
};

export type FetchWithResponseReleaseResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
  refreshTimeout?: () => void;
};

const DEFAULT_MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isTruthyEnvValue(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function resolveDispatcherTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return timeoutMs ?? globalUndiciStreamTimeoutMs;
}

function normalizeLookupResults(results: LookupResult): readonly LookupAddress[] {
  return Array.isArray(results) ? results : [results];
}

function resolveManagedProxyEnabled(): boolean {
  return getActiveManagedProxyLoopbackMode() !== undefined;
}

function assertHttpUrl(url: URL, operation: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${operation} only supports http and https URLs`);
  }
}

async function assertUntrustedUrlAllowed(params: {
  url: URL;
  lookupFn?: LookupFn;
  proxyEnabled?: boolean;
  operation: string;
  directPins?: Map<string, PinnedHostnameOverride>;
}): Promise<PinnedHostnameOverride | undefined> {
  assertHttpUrl(params.url, params.operation);
  // This is a stock safety guard for default direct mode. The high-assurance
  // egress boundary is proxy.enabled plus the operator's external proxy policy.
  if (params.proxyEnabled ?? resolveManagedProxyEnabled()) {
    return undefined;
  }
  const hostname = normalizeHostname(params.url.hostname);
  if (isBlockedHostnameOrIp(hostname)) {
    throw new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address");
  }
  if (parseCanonicalIpAddress(hostname)) {
    const pin = { hostname, addresses: [hostname] };
    params.directPins?.set(params.url.toString(), pin);
    return pin;
  }
  const lookupFn = params.lookupFn ?? dnsLookup;
  const records = normalizeLookupResults((await lookupFn(hostname, { all: true })) as LookupResult);
  if (records.length === 0) {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }
  for (const record of records) {
    if (isBlockedHostnameOrIp(record.address)) {
      throw new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address");
    }
  }
  const addresses = [...new Set(records.map((record) => record.address))];
  const pin = { hostname, addresses };
  params.directPins?.set(params.url.toString(), pin);
  return pin;
}

async function validateEgressUrl(params: {
  url: URL;
  previousUrl?: URL;
  redirectCount: number;
  mode: HttpEgressMode;
  operation: string;
  validateUrl?: FetchWithEgressPolicyOptions["validateUrl"];
}): Promise<void> {
  assertHttpUrl(params.url, params.operation);
  await params.validateUrl?.(params.url, {
    ...(params.previousUrl ? { previousUrl: params.previousUrl } : {}),
    redirectCount: params.redirectCount,
  });
  if (params.mode.kind === "untrustedUrl") {
    await assertUntrustedUrlAllowed({
      url: params.url,
      lookupFn: params.mode.lookupFn,
      proxyEnabled: params.mode.proxyEnabled,
      operation: params.operation,
      directPins: params.mode.directPins,
    });
  }
}

function dropRedirectBodyHeaders(headers?: HeadersInit): Headers | undefined {
  if (!headers) {
    return undefined;
  }
  const next = new Headers(headers);
  next.delete("content-encoding");
  next.delete("content-language");
  next.delete("content-length");
  next.delete("content-location");
  next.delete("content-type");
  next.delete("transfer-encoding");
  return next;
}

function rewriteRedirectInitForMethod(
  init: DispatcherAwareRequestInit | undefined,
  status: number,
): DispatcherAwareRequestInit | undefined {
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
    headers: dropRedirectBodyHeaders(init.headers),
  };
}

function rewriteRedirectInitForCrossOrigin(params: {
  init: DispatcherAwareRequestInit | undefined;
  allowUnsafeReplay: boolean;
}): DispatcherAwareRequestInit | undefined {
  const init = params.init;
  if (!init) {
    return init;
  }
  const safeHeaders = retainSafeHeadersForCrossOriginRedirect(init.headers);
  const currentMethod = init.method?.toUpperCase() ?? "GET";
  if (params.allowUnsafeReplay || currentMethod === "GET" || currentMethod === "HEAD") {
    return { ...init, headers: safeHeaders };
  }
  return {
    ...init,
    body: undefined,
    headers: dropRedirectBodyHeaders(safeHeaders),
  };
}

async function cancelResponseBody(response: Response | undefined): Promise<void> {
  const body = response?.body;
  const cancel = body && (body as { cancel?: unknown }).cancel;
  if (typeof cancel !== "function") {
    return;
  }
  await Promise.resolve(cancel.call(body)).catch(() => undefined);
}

async function captureDefaultEgressHttpExchange(params: {
  url: string;
  init: DispatcherAwareRequestInit;
  response: Response;
  capturedByGlobalFetchPatch: boolean;
  captureOrigin: string;
}): Promise<void> {
  if (!isTruthyEnvValue(process.env.OPENCLAW_DEBUG_PROXY_ENABLED)) {
    return;
  }
  const [
    { resolveDebugProxySettings },
    { captureHttpExchange, isDebugProxyGlobalFetchPatchInstalled },
  ] = await Promise.all([
    import("../../proxy-capture/env.js"),
    import("../../proxy-capture/runtime.js"),
  ]);
  const settings = resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  if (params.capturedByGlobalFetchPatch && isDebugProxyGlobalFetchPatchInstalled()) {
    return;
  }
  captureHttpExchange(
    {
      url: params.url,
      method: params.init.method ?? "GET",
      requestHeaders: params.init.headers as Headers | Record<string, string> | undefined,
      requestBody:
        (params.init as (RequestInit & { body?: BodyInit | Buffer | string | null }) | undefined)
          ?.body ?? null,
      response: params.response,
      transport: "http",
      meta: {
        captureOrigin: params.captureOrigin,
      },
    },
    settings,
  );
}

export function resolveEgressDispatcherPolicy(params: {
  url: string;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  useEnvProxy?: boolean;
}): PinnedDispatcherPolicy | undefined {
  if (params.useEnvProxy === false || !shouldUseEnvHttpProxyForUrl(params.url)) {
    return params.dispatcherPolicy;
  }
  if (!params.dispatcherPolicy) {
    return { mode: "env-proxy" };
  }
  if (params.dispatcherPolicy.mode !== "direct") {
    return params.dispatcherPolicy;
  }
  return {
    mode: "env-proxy",
    ...(params.dispatcherPolicy.connect ? { connect: { ...params.dispatcherPolicy.connect } } : {}),
  };
}

export async function createEgressDispatcher(params: {
  url: URL;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  timeoutMs?: number;
  lookupFn?: LookupFn;
  policy?: SsrFPolicy;
}): Promise<Dispatcher | undefined> {
  const dispatcherPolicy = params.dispatcherPolicy;
  if (!dispatcherPolicy) {
    return undefined;
  }
  const timeoutMs = resolveDispatcherTimeoutMs(params.timeoutMs);
  if (dispatcherPolicy.pinnedHostname) {
    const normalizedHostname = normalizeHostname(params.url.hostname);
    const normalizedPinnedHostname = normalizeHostname(dispatcherPolicy.pinnedHostname.hostname);
    const pinned =
      normalizedPinnedHostname === normalizedHostname
        ? {
            hostname: normalizedHostname,
            addresses: [...dispatcherPolicy.pinnedHostname.addresses],
            lookup: createPinnedLookup({
              hostname: normalizedHostname,
              addresses: [...dispatcherPolicy.pinnedHostname.addresses],
            }),
          }
        : await resolvePinnedHostnameWithPolicy(params.url.hostname, {
            lookupFn: params.lookupFn,
            policy: params.policy,
          });
    return createPinnedDispatcher(pinned, dispatcherPolicy, params.policy, timeoutMs);
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
        ...(dispatcherPolicy.connect
          ? {
              connect: { ...dispatcherPolicy.connect },
              requestTls: { ...dispatcherPolicy.connect },
            }
          : {}),
        ...(dispatcherPolicy.proxyTls ? { proxyTls: { ...dispatcherPolicy.proxyTls } } : {}),
      },
      timeoutMs,
    );
  }
  const proxyUrl = dispatcherPolicy.proxyUrl.trim();
  if (dispatcherPolicy.proxyTls) {
    return createHttp1ProxyAgent(
      { uri: proxyUrl, requestTls: { ...dispatcherPolicy.proxyTls } },
      timeoutMs,
    );
  }
  return createHttp1ProxyAgent({ uri: proxyUrl }, timeoutMs);
}

async function resolvePolicyForUrl(
  policy:
    | PinnedDispatcherPolicy
    | ((
        url: URL,
      ) => PinnedDispatcherPolicy | undefined | Promise<PinnedDispatcherPolicy | undefined>)
    | undefined,
  url: URL,
): Promise<PinnedDispatcherPolicy | undefined> {
  return typeof policy === "function" ? await policy(url) : policy;
}

function hasCallerDispatcher(init: DispatcherAwareRequestInit | undefined): boolean {
  return Boolean(init?.dispatcher);
}

async function fetchEgressOnce(params: {
  url: URL;
  init: DispatcherAwareRequestInit | undefined;
  fetchImpl: FetchLike;
  timeoutSignal?: AbortSignal;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  timeoutMs?: number;
  lookupFn?: LookupFn;
  useEnvProxy?: boolean;
}): Promise<{
  response: Response;
  init: DispatcherAwareRequestInit;
  dispatcher?: Dispatcher;
  usingRuntimeFetch: boolean;
}> {
  const requestedPolicy = hasCallerDispatcher(params.init)
    ? undefined
    : resolveEgressDispatcherPolicy({
        url: params.url.toString(),
        dispatcherPolicy: params.dispatcherPolicy,
        useEnvProxy: params.useEnvProxy,
      });
  const dispatcher = await createEgressDispatcher({
    url: params.url,
    dispatcherPolicy: requestedPolicy,
    timeoutMs: params.timeoutMs,
    lookupFn: params.lookupFn,
  });
  const init: DispatcherAwareRequestInit = {
    ...(params.init ? { ...params.init } : {}),
    redirect: "manual",
    ...(params.timeoutSignal ? { signal: params.timeoutSignal } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  };
  const usingRuntimeFetch =
    Boolean(init.dispatcher) &&
    params.fetchImpl === globalThis.fetch &&
    !isMockedFetch(params.fetchImpl);
  try {
    const response = usingRuntimeFetch
      ? await fetchWithRuntimeDispatcher(params.url.toString(), init)
      : await params.fetchImpl(params.url.toString(), init);
    return { response, init, dispatcher, usingRuntimeFetch };
  } catch (error) {
    await closeDispatcher(dispatcher);
    throw error;
  }
}

export async function fetchWithEgressPolicy(
  params: FetchWithEgressPolicyOptions,
): Promise<FetchWithResponseReleaseResult> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const operation = params.operation ?? "fetchWithEgressPolicy";
  const mode = params.mode ?? ({ kind: "operatorConfiguredEndpoint" } satisfies HttpEgressMode);
  const timeout = buildTimeoutAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal ?? params.init?.signal ?? undefined,
    operation,
    url: params.url,
  });
  let released = false;
  let response: Response | undefined;
  let dispatcher: Dispatcher | undefined;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    timeout.cleanup();
    await cancelResponseBody(response);
    await closeDispatcher(dispatcher);
  };
  try {
    let currentUrl = params.url;
    let currentInit: DispatcherAwareRequestInit | undefined = params.init
      ? { ...params.init }
      : undefined;
    let previousUrl: URL | undefined;
    const maxRedirects = Math.max(0, Math.floor(params.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
    const visited = new Set<string>();
    for (let redirectCount = 0; ; redirectCount += 1) {
      const parsedUrl = new URL(currentUrl);
      const visitKey = `${currentInit?.method?.toUpperCase() ?? "GET"} ${parsedUrl.toString()}`;
      if (visited.has(visitKey)) {
        throw new Error(`Redirect loop detected for ${parsedUrl.toString()}`);
      }
      visited.add(visitKey);
      await validateEgressUrl({
        url: parsedUrl,
        previousUrl,
        redirectCount,
        mode,
        operation,
        validateUrl: params.validateUrl,
      });
      const activeDispatcherPolicy = await resolvePolicyForUrl(params.dispatcherPolicy, parsedUrl);
      const fetched = await fetchEgressOnce({
        url: parsedUrl,
        init: currentInit,
        fetchImpl,
        timeoutSignal: timeout.signal,
        dispatcherPolicy: activeDispatcherPolicy,
        timeoutMs: params.timeoutMs,
        lookupFn: mode.kind === "untrustedUrl" ? mode.lookupFn : undefined,
        useEnvProxy: params.useEnvProxy,
      });
      response = fetched.response;
      dispatcher = fetched.dispatcher;
      await params.onResponse?.({
        url: parsedUrl.toString(),
        init: fetched.init,
        response,
        capturedByGlobalFetchPatch: !fetched.usingRuntimeFetch && fetchImpl === globalThis.fetch,
        usingRuntimeFetch: fetched.usingRuntimeFetch,
      });
      if (params.followRedirects === false || !REDIRECT_STATUSES.has(response.status)) {
        break;
      }
      const status = response.status;
      const location = response.headers.get("location");
      await cancelResponseBody(response);
      response = undefined;
      await closeDispatcher(dispatcher);
      dispatcher = undefined;
      if (!location) {
        throw new Error(`Redirect missing location header (${status})`);
      }
      if (redirectCount + 1 > maxRedirects) {
        throw new Error(`Too many redirects (limit: ${maxRedirects})`);
      }
      const nextUrl = new URL(location, parsedUrl);
      previousUrl = parsedUrl;
      currentInit = rewriteRedirectInitForMethod(currentInit, status);
      if (nextUrl.origin !== parsedUrl.origin) {
        currentInit = rewriteRedirectInitForCrossOrigin({
          init: currentInit,
          allowUnsafeReplay: params.allowCrossOriginUnsafeRedirectReplay === true,
        });
      }
      currentUrl = nextUrl.toString();
      timeout.refresh();
    }
    return {
      response,
      finalUrl: response.url || currentUrl,
      release,
      refreshTimeout: timeout.refresh,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function fetchWithResponseRelease(
  params: FetchWithResponseReleaseOptions,
): Promise<FetchWithResponseReleaseResult> {
  return await fetchWithEgressPolicy({
    ...params,
    mode: { kind: "operatorConfiguredEndpoint" },
    operation: params.operation ?? "fetchWithResponseRelease",
  });
}

export async function fetchOperatorConfiguredEndpoint(
  params: FetchWithResponseReleaseOptions,
): Promise<FetchWithResponseReleaseResult> {
  return await fetchWithEgressPolicy({
    ...params,
    mode: { kind: "operatorConfiguredEndpoint" },
    operation: params.operation ?? "operator-configured-fetch",
  });
}

export async function fetchUntrustedUrl(
  params: Omit<FetchWithEgressPolicyOptions, "mode" | "useEnvProxy"> & {
    lookupFn?: LookupFn;
    proxyEnabled?: boolean;
  },
): Promise<FetchWithResponseReleaseResult> {
  const { lookupFn, proxyEnabled, onResponse, operation, ...rest } = params;
  const shouldUseEnvProxy = proxyEnabled ?? resolveManagedProxyEnabled();
  const directPins = new Map<string, PinnedHostnameOverride>();
  // Ambient env proxies can resolve/rewrite outside the stock direct-mode guard.
  // In direct mode, install a per-request direct dispatcher to bypass globals too.
  const dispatcherPolicy = shouldUseEnvProxy
    ? rest.dispatcherPolicy
    : async (url: URL) => {
        const resolvedPolicy = await resolvePolicyForUrl(rest.dispatcherPolicy, url);
        if (resolvedPolicy?.pinnedHostname) {
          return resolvedPolicy;
        }
        if (resolvedPolicy && resolvedPolicy.mode !== "direct") {
          return resolvedPolicy;
        }
        const pinnedHostname =
          directPins.get(url.toString()) ??
          (await assertUntrustedUrlAllowed({
            url,
            lookupFn,
            proxyEnabled: false,
            operation: operation ?? "untrusted-url-fetch",
            directPins,
          }));
        return {
          ...(resolvedPolicy ?? { mode: "direct" as const }),
          ...(pinnedHostname ? { pinnedHostname } : {}),
        };
      };
  const captureOrigin = operation ?? "untrusted-url-fetch";
  return await fetchWithEgressPolicy({
    ...rest,
    mode: { kind: "untrustedUrl", lookupFn, proxyEnabled, directPins },
    operation: captureOrigin,
    dispatcherPolicy,
    onResponse:
      onResponse ??
      (async ({ url, init, response, capturedByGlobalFetchPatch }) => {
        await captureDefaultEgressHttpExchange({
          url,
          init,
          response,
          capturedByGlobalFetchPatch,
          captureOrigin,
        });
      }),
    useEnvProxy: shouldUseEnvProxy,
  });
}
