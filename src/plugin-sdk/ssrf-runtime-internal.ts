// Private helper surface for bundled plugins with configured local IPC.
// Keep managed proxy bypass capabilities out of the public plugin SDK surface.
import { lookup as dnsLookup } from "node:dns/promises";
import { shouldUseConfiguredLocalOriginManagedProxyBypass } from "../infra/net/configured-local-origin-bypass.js";
import {
  fetchOperatorConfiguredEndpoint,
  type FetchWithResponseReleaseResult,
} from "../infra/net/egress-fetch.js";
import { normalizeHostname } from "../infra/net/hostname.js";
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import { getActiveManagedProxyLoopbackMode } from "../infra/net/proxy/active-proxy-state.js";
import { registerManagedProxyBrowserCdpBypass } from "../infra/net/proxy/proxy-lifecycle.js";
import {
  matchesHostnameAllowlist,
  normalizeHostnameAllowlist,
  type LookupFn,
  type PinnedDispatcherPolicy,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

export { registerManagedProxyBrowserCdpBypass };

export type ConfiguredLocalOriginFetchOptions = {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  policy?: SsrFPolicy;
  lookupFn?: LookupFn;
  configuredLocalOriginBaseUrl: string;
  auditContext?: string;
};

function normalizePolicyOrigin(value: string): string | undefined {
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

function assertConfiguredLocalOriginUrlAllowed(url: URL, policy?: SsrFPolicy): void {
  const hostnameAllowlist = normalizeHostnameAllowlist([
    ...(policy?.allowedHostnames ?? []),
    ...(policy?.hostnameAllowlist ?? []),
  ]);
  const allowedOrigins = (policy?.allowedOrigins ?? [])
    .map((origin) => normalizePolicyOrigin(origin))
    .filter((origin): origin is string => Boolean(origin));
  if (hostnameAllowlist.length === 0 && allowedOrigins.length === 0) {
    return;
  }
  const hostname = normalizeHostname(url.hostname);
  const origin = normalizePolicyOrigin(url.toString());
  const hostAllowed =
    hostnameAllowlist.length > 0 && matchesHostnameAllowlist(hostname, hostnameAllowlist);
  const originAllowed = origin ? allowedOrigins.includes(origin) : false;
  if (!hostAllowed && !originAllowed) {
    throw new Error(`Blocked hostname (not in allowlist): ${url.hostname}`);
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

export async function fetchConfiguredLocalOriginWithEgressPolicy(
  params: ConfiguredLocalOriginFetchOptions,
): Promise<FetchWithResponseReleaseResult> {
  return await fetchOperatorConfiguredEndpoint({
    url: params.url,
    init: params.init,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
    operation: params.auditContext ?? "configured-local-origin-fetch",
    validateUrl: (url) => {
      assertConfiguredLocalOriginUrlAllowed(url, params.policy);
    },
    dispatcherPolicy: async (url) =>
      await resolveConfiguredLocalOriginDispatcherPolicy({
        url,
        baseUrl: params.configuredLocalOriginBaseUrl,
        lookupFn: params.lookupFn,
      }),
    useEnvProxy: false,
  });
}
