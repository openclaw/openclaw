import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
} from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

export const WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY: SsrFPolicy = {
  dangerouslyAllowPrivateNetwork: true,
};

type WebToolGuardedFetchOptions = Omit<GuardedFetchOptions, "proxy"> & {
  timeoutSeconds?: number;
};

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
  const { timeoutSeconds, ...rest } = params;
  return fetchWithSsrFGuard({
    ...rest,
    timeoutMs: resolveTimeoutMs({ timeoutMs: rest.timeoutMs, timeoutSeconds }),
    proxy: "env",
  });
}

export async function withWebToolsNetworkGuard<T>(
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
