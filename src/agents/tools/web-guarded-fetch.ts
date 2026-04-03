import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
  withStrictGuardedFetchMode,
  withTrustedEnvProxyGuardedFetchMode,
} from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

type WebToolGuardedFetchOptions = Omit<
  GuardedFetchOptions,
  "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns"
> & {
  timeoutSeconds?: number;
  useEnvProxy?: boolean;
  allowRfc2544BenchmarkRange?: boolean;
};
type WebToolEndpointFetchOptions = Omit<WebToolGuardedFetchOptions, "policy" | "useEnvProxy" | "allowRfc2544BenchmarkRange">;

function resolveTimeoutMs(params: {
  timeoutMs?: number;
  timeoutSeconds?: number;
}): number | undefined {
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    return params.timeoutMs;
  }
  if (typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)) {
    return params.timeoutSeconds * 1000;
  }
  return undefined;
}

export async function fetchWithWebToolsNetworkGuard(
  params: WebToolGuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const { timeoutSeconds, useEnvProxy, allowRfc2544BenchmarkRange, ...rest } = params;

  const policy: SsrFPolicy = {
    ...(useEnvProxy ? { dangerouslyAllowPrivateNetwork: true } : {}),
    allowRfc2544BenchmarkRange: allowRfc2544BenchmarkRange === true,
  };

  const resolved = {
    ...rest,
    policy,
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

export async function withTrustedWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return await withWebToolsNetworkGuard(
    {
      ...params,
      useEnvProxy: true,
      allowRfc2544BenchmarkRange: true,
    },
    run,
  );
}

export async function withStrictWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return await withWebToolsNetworkGuard(params, run);
}
