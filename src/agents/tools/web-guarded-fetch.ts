import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
  withStrictGuardedFetchMode,
  withTrustedEnvProxyGuardedFetchMode,
} from "../../infra/net/fetch-guard.js";
import {
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
  SsrFBlockedError,
  type SsrFPolicy,
} from "../../infra/net/ssrf.js";
import { readPositiveIntegerParam } from "./common.js";

const WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY: SsrFPolicy = {
  dangerouslyAllowPrivateNetwork: true,
  allowRfc2544BenchmarkRange: true,
  allowIpv6UniqueLocalRange: true,
};

type WebToolGuardedFetchOptions = Omit<
  GuardedFetchOptions,
  "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns"
> & {
  timeoutSeconds?: number;
  useEnvProxy?: boolean;
};
type WebToolEndpointFetchOptions = Omit<WebToolGuardedFetchOptions, "policy" | "useEnvProxy">;

function resolveTimeoutMs(params: {
  timeoutMs?: number;
  timeoutSeconds?: number;
}): number | undefined {
  const timeoutMs = readPositiveIntegerParam(params, "timeoutMs");
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }
  const timeoutSeconds = readPositiveIntegerParam(params, "timeoutSeconds");
  return timeoutSeconds === undefined
    ? undefined
    : finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, { floorSeconds: true });
}

/** Runs a guarded fetch with strict or trusted-env-proxy web tool policy. */
export async function fetchWithWebToolsNetworkGuard(
  params: WebToolGuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const { timeoutSeconds, useEnvProxy, ...rest } = params;
  const resolved = {
    ...rest,
    timeoutMs: resolveTimeoutMs({ timeoutMs: rest.timeoutMs, timeoutSeconds }),
  };
  return fetchWithSsrFGuard(
    useEnvProxy
      ? withTrustedEnvProxyGuardedFetchMode(resolved)
      : withStrictGuardedFetchMode(resolved),
  );
}

async function withWebToolsNetworkGuard<T>(
  params: WebToolGuardedFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  const { response, finalUrl, release } = await fetchWithWebToolsNetworkGuard(params);
  try {
    return await run({ response, finalUrl });
  } finally {
    await release();
  }
}

/** Runs a fetch for trusted endpoints, allowing env proxy with pinned-host policy. */
export async function withTrustedWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  const trustedPolicy = ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(params.url) ?? {};
  return await withWebToolsNetworkGuard(
    {
      ...params,
      policy: trustedPolicy,
      useEnvProxy: true,
    },
    run,
  );
}

/** Trusts one configured origin without delegating DNS or redirect trust to a proxy. */
export async function withOriginScopedSelfHostedWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions & { selfHostedBaseUrl: string },
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  const { selfHostedBaseUrl, ...options } = params;
  const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(selfHostedBaseUrl);
  if (!policy || new URL(options.url).origin !== new URL(selfHostedBaseUrl).origin) {
    throw new SsrFBlockedError("Blocked: request leaves the configured endpoint origin");
  }
  return await withWebToolsNetworkGuard(
    {
      ...options,
      policy,
      requireSameOriginRedirects: true,
      pinDns: true,
      // Explicit direct routing prevents ambient/managed proxies from resolving
      // the trusted hostname again instead of using the validated DNS snapshot.
      useEnvProxy: true,
      dispatcherPolicy: { mode: "direct" },
      resolveDispatcherPolicy: undefined,
    },
    run,
  );
}

/** Runs a fetch for configured self-hosted endpoints with private-network access allowed. */
export async function withSelfHostedWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return await withWebToolsNetworkGuard(
    {
      ...params,
      policy: WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY,
      useEnvProxy: true,
    },
    run,
  );
}

/** Runs a fetch under strict SSRF protection without env proxy trust. */
export async function withStrictWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return await withWebToolsNetworkGuard(params, run);
}
