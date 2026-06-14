/**
 * Fetch transport wrappers for web tools.
 *
 * Applies timeout normalization for app-owned fetches and keeps credentialed
 * provider endpoints on guarded SSRF/private-network egress.
 */
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
  withStrictGuardedFetchMode,
  withTrustedEnvProxyGuardedFetchMode,
} from "../../infra/net/fetch-guard.js";
import {
  fetchWithAppNetworkTransport,
  type AppFetchTransportOptions,
  type AppFetchTransportResult,
} from "../../infra/net/fetch-transport.js";
import {
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
  type SsrFPolicy,
} from "../../infra/net/ssrf.js";
import { readPositiveIntegerParam } from "./common.js";

const WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY: SsrFPolicy = {
  dangerouslyAllowPrivateNetwork: true,
  allowRfc2544BenchmarkRange: true,
  allowIpv6UniqueLocalRange: true,
};

type WebToolAppFetchOptions = Omit<AppFetchTransportOptions, "timeoutMs"> & {
  timeoutSeconds?: number;
  timeoutMs?: number;
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
  const timeoutMs = readPositiveIntegerParam(params as Record<string, unknown>, "timeoutMs");
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }
  const timeoutSeconds = readPositiveIntegerParam(
    params as Record<string, unknown>,
    "timeoutSeconds",
  );
  if (timeoutSeconds !== undefined) {
    return finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, { floorSeconds: true });
  }
  return undefined;
}

/** Runs a web tool fetch through the shared app egress transport. */
export async function fetchWithWebToolsNetworkGuard(
  params: WebToolAppFetchOptions,
): Promise<AppFetchTransportResult> {
  const { timeoutSeconds, ...rest } = params;
  return await fetchWithAppNetworkTransport({
    ...rest,
    timeoutMs: resolveTimeoutMs({ timeoutMs: rest.timeoutMs, timeoutSeconds }),
  });
}

async function fetchWithGuardedWebToolsNetwork(
  params: WebToolGuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const { timeoutSeconds, useEnvProxy, ...rest } = params;
  const resolved = {
    ...rest,
    timeoutMs: resolveTimeoutMs({ timeoutMs: rest.timeoutMs, timeoutSeconds }),
  };
  return await fetchWithSsrFGuard(
    useEnvProxy
      ? withTrustedEnvProxyGuardedFetchMode(resolved)
      : withStrictGuardedFetchMode(resolved),
  );
}

async function withGuardedWebToolsNetwork<T>(
  params: WebToolGuardedFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  const { response, finalUrl, release } = await fetchWithGuardedWebToolsNetwork(params);
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
  return await withGuardedWebToolsNetwork(
    {
      ...params,
      policy: trustedPolicy,
      useEnvProxy: true,
    },
    run,
  );
}

/** Runs a fetch for configured self-hosted endpoints with private-network access allowed. */
export async function withSelfHostedWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return await withGuardedWebToolsNetwork(
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
  return await withGuardedWebToolsNetwork(params, run);
}
