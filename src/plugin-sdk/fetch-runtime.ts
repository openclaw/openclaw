// Public fetch/proxy helpers for plugins that need wrapped fetch behavior.

import { lookup as dnsLookup } from "node:dns/promises";
import { shouldUseConfiguredLocalOriginManagedProxyBypass } from "../infra/net/configured-local-origin-bypass.js";
import {
  fetchOperatorConfiguredEndpoint as fetchOperatorConfiguredEndpointInternal,
  fetchUntrustedUrl as fetchUntrustedUrlInternal,
  fetchWithResponseRelease as fetchWithResponseReleaseInternal,
  type FetchWithResponseReleaseResult,
} from "../infra/net/egress-fetch.js";
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import { getActiveManagedProxyLoopbackMode } from "../infra/net/proxy/active-proxy-state.js";
import type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";

export { resolveFetch, wrapFetchWithAbortSignal } from "../infra/fetch.js";
export { type FetchWithResponseReleaseResult } from "../infra/net/egress-fetch.js";
export {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "../infra/net/undici-runtime.js";
export {
  addActiveManagedProxyTlsOptions,
  resolveActiveManagedProxyTlsOptions,
} from "../infra/net/proxy/managed-proxy-undici.js";
export {
  createNodeProxyAgent,
  type CreateNodeProxyAgentOptions,
} from "../infra/net/node-proxy-agent.js";
export {
  hasEnvHttpProxyConfigured,
  hasEnvHttpProxyAgentConfigured,
  resolveEnvHttpProxyAgentOptions,
  resolveEnvHttpProxyUrl,
  shouldUseEnvHttpProxyForUrl,
} from "../infra/net/proxy-env.js";
export { getProxyUrlFromFetch, makeProxyFetch } from "../infra/net/proxy-fetch.js";

type LookupFn = typeof dnsLookup;

type FetchRuntimeRequestInit = RequestInit & {
  dispatcher?: unknown;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type FetchRuntimeOptions = {
  url: string;
  init?: FetchRuntimeRequestInit;
  fetchImpl?: FetchLike;
  followRedirects?: boolean;
  maxRedirects?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  operation?: string;
  validateUrl?: (
    url: URL,
    context: { previousUrl?: URL; redirectCount: number },
  ) => void | Promise<void>;
  useEnvProxy?: boolean;
  allowCrossOriginUnsafeRedirectReplay?: boolean;
  onResponse?: (params: {
    url: string;
    init: FetchRuntimeRequestInit;
    response: Response;
    capturedByGlobalFetchPatch: boolean;
    usingRuntimeFetch: boolean;
  }) => void | Promise<void>;
};

export type FetchWithResponseReleaseOptions = FetchRuntimeOptions;

function normalizeHttpOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function assertConfiguredLocalOriginUrlAllowed(url: URL, baseUrl: string): void {
  const expectedOrigin = normalizeHttpOrigin(baseUrl);
  const requestOrigin = normalizeHttpOrigin(url.toString());
  if (expectedOrigin && requestOrigin !== expectedOrigin) {
    throw new Error(`Blocked hostname (not configured local origin): ${url.hostname}`);
  }
}

async function resolveLookupAddresses(
  hostname: string,
  lookupFn: LookupFn,
): Promise<readonly string[]> {
  const results = await lookupFn(hostname, { all: true });
  const records = Array.isArray(results) ? results : [results];
  return records.map((record) => record.address);
}

async function resolveConfiguredLocalOriginDispatcherPolicy(params: {
  url: URL;
  baseUrl: string;
  lookupFn?: LookupFn;
}): Promise<PinnedDispatcherPolicy | undefined> {
  if (getActiveManagedProxyLoopbackMode() === undefined || !hasProxyEnvConfigured()) {
    return undefined;
  }
  const resolvedAddresses = await resolveLookupAddresses(
    params.url.hostname,
    params.lookupFn ?? dnsLookup,
  );
  return shouldUseConfiguredLocalOriginManagedProxyBypass({
    url: params.url,
    managedProxyBypass: {
      kind: "configured-local-origin",
      baseUrl: params.baseUrl,
    },
    resolvedAddresses,
  })
    ? { mode: "direct" }
    : { mode: "env-proxy" };
}

export async function fetchWithResponseRelease(
  params: FetchRuntimeOptions,
): Promise<FetchWithResponseReleaseResult> {
  return await fetchWithResponseReleaseInternal(
    params as Parameters<typeof fetchWithResponseReleaseInternal>[0],
  );
}

export async function fetchOperatorConfiguredEndpoint(
  params: FetchRuntimeOptions,
): Promise<FetchWithResponseReleaseResult> {
  return await fetchOperatorConfiguredEndpointInternal(
    params as Parameters<typeof fetchOperatorConfiguredEndpointInternal>[0],
  );
}

export async function fetchUntrustedUrl(
  params: FetchRuntimeOptions,
): Promise<FetchWithResponseReleaseResult> {
  return await fetchUntrustedUrlInternal(params as Parameters<typeof fetchUntrustedUrlInternal>[0]);
}

export async function fetchConfiguredLocalOrigin(
  params: FetchRuntimeOptions & {
    configuredLocalOriginBaseUrl: string;
    lookupFn?: LookupFn;
  },
): Promise<FetchWithResponseReleaseResult> {
  return await fetchOperatorConfiguredEndpointInternal({
    url: params.url,
    init: params.init,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    followRedirects: params.followRedirects,
    maxRedirects: params.maxRedirects,
    operation: params.operation ?? "configured-local-origin-fetch",
    validateUrl: (url) => {
      assertConfiguredLocalOriginUrlAllowed(url, params.configuredLocalOriginBaseUrl);
    },
    dispatcherPolicy: async (url) =>
      await resolveConfiguredLocalOriginDispatcherPolicy({
        url,
        baseUrl: params.configuredLocalOriginBaseUrl,
        lookupFn: params.lookupFn,
      }),
    useEnvProxy: false,
  } as Parameters<typeof fetchOperatorConfiguredEndpointInternal>[0]);
}
