import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
  withStrictGuardedFetchMode,
  withTrustedEnvProxyGuardedFetchMode,
} from "../../infra/net/fetch-guard.js";
import {
  isCloudMetadataHostnameOrIp,
  mergeSsrFPolicies,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
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
  trustedPolicy?: SsrFPolicy,
): Promise<T> {
  const { response, finalUrl, release } = await fetchWithWebToolsNetworkGuard(
    trustedPolicy ? { ...params, policy: trustedPolicy, useEnvProxy: true } : params,
  );
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
  return await withWebToolsNetworkGuard(
    params,
    run,
    ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(params.url) ?? {},
  );
}

/** Runs a fetch for configured self-hosted endpoints with private-network access allowed. */
export async function withSelfHostedWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return await withWebToolsNetworkGuard(params, run, WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY);
}

/**
 * Runs a fetch for one operator-configured endpoint with exact-host trust. The
 * host named in `params.url` is honored as typed, including loopback and
 * private addresses, because the operator chose it. A cloud-metadata
 * destination is refused in every mode. A configured name whose DNS answer is
 * loopback, unspecified, link-local or cloud-metadata is refused, since that
 * answer was not the operator's choice. Every other host, including a redirect
 * target, is refused. With an env proxy the proxy resolves the name, as for
 * every trusted call.
 */
export async function withPinnedTrustedHostWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  const pinnedPolicy = ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(params.url);
  if (!pinnedPolicy || isCloudMetadataHostnameOrIp(new URL(params.url).hostname)) {
    // Not an http(s) URL, or a cloud-metadata destination: let the strict guard
    // reject it rather than widen the policy. The strict pre-DNS check runs in
    // direct and env-proxy mode alike, so no request or lookup follows.
    return await withWebToolsNetworkGuard(params, run);
  }
  return await withWebToolsNetworkGuard(
    {
      ...params,
      policy: mergeSsrFPolicies(pinnedPolicy, ssrfPolicyFromHttpBaseUrlAllowedHostname(params.url)),
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
