import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
} from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { ClarityBurstAbstainError } from "../../clarityburst/errors.js";
import { applyNetworkOverrides, type NetworkContext } from "../../clarityburst/decision-override.js";

export const WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY: SsrFPolicy = {
  dangerouslyAllowPrivateNetwork: true,
};

type WebToolGuardedFetchOptions = Omit<GuardedFetchOptions, "proxy"> & {
  timeoutSeconds?: number;
};

function extractHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

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

/**
 * Apply NETWORK_IO gate without executing fetch.
 * Used to fail-closed before SSRF guard and network operations.
 */
async function applyNetworkIOGate(url: string, init?: RequestInit): Promise<void> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const hostname = extractHostname(url);

  const context: NetworkContext = {
    stageId: "NETWORK_IO",
    operation: method,
    url: hostname,
    userConfirmed: false,
  };

  const gateResult = await applyNetworkOverrides(context);

  if (gateResult.outcome.startsWith("ABSTAIN")) {
    const outcome = gateResult.outcome as "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY";
    const reason = (gateResult as any).reason ?? "unknown";
    const contractId = gateResult.contractId ?? null;
    const instructions =
      (gateResult as any).instructions ?? `Network request to ${hostname} blocked by ClarityBurst NETWORK_IO gate.`;

    throw new ClarityBurstAbstainError({
      stageId: "NETWORK_IO",
      outcome,
      reason,
      contractId,
      instructions,
    });
  }
}

export async function fetchWithWebToolsNetworkGuard(
  params: WebToolGuardedFetchOptions,
): Promise<GuardedFetchResult> {
  // Apply NETWORK_IO gate FIRST (fail-closed, before any network operation)
  await applyNetworkIOGate(params.url, params.init);

  // Gate approved: proceed with SSRF guard + actual request
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
