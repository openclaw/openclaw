import type { ProviderError, RetryPolicy } from "./provider-error.js";
import { DEFAULT_RETRY_POLICY, parseProviderError, retryWithBackoff } from "./provider-error.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageProviderId } from "./provider-usage.types.js";

export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(controller.abort.bind(controller), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJsonWithRetry(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  onRetry?: (attempt: number, max: number, delayMs: number) => void,
): Promise<Response> {
  const res = await fetchJson(url, init, timeoutMs, fetchFn);
  if (res.ok) {
    return res;
  }

  const providerErr = await parseProviderError(provider, res);

  if (!providerErr.retryable) {
    return res;
  }

  let lastFailedRes: Response = res;

  return retryWithBackoff(
    async () => {
      const retryRes = await fetchJson(url, init, timeoutMs, fetchFn);
      if (!retryRes.ok) {
        lastFailedRes = retryRes;
        let retryErr: ProviderError;
        try {
          retryErr = await parseProviderError(provider, retryRes);
        } catch {
          retryErr = {
            provider,
            httpStatus: retryRes.status,
            category: "unknown",
            retryAfterMs: null,
            message: `${provider} error (${retryRes.status}).`,
            retryable: false,
            raw: null,
          };
        }
        throw retryErr;
      }
      return retryRes;
    },
    policy,
    providerErr,
    onRetry ? (attempt, max, delayMs) => onRetry(attempt, max, delayMs) : undefined,
  ).catch((_err: unknown) => {
    return lastFailedRes;
  });
}

export function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

type BuildUsageHttpErrorSnapshotOptions = {
  provider: UsageProviderId;
  status: number;
  message?: string;
  tokenExpiredStatuses?: readonly number[];
};

export function buildUsageErrorSnapshot(
  provider: UsageProviderId,
  error: string,
): ProviderUsageSnapshot {
  return {
    provider,
    displayName: PROVIDER_LABELS[provider],
    windows: [],
    error,
  };
}

export function buildUsageHttpErrorSnapshot(
  options: BuildUsageHttpErrorSnapshotOptions,
): ProviderUsageSnapshot {
  const tokenExpiredStatuses = options.tokenExpiredStatuses ?? [];
  if (tokenExpiredStatuses.includes(options.status)) {
    return buildUsageErrorSnapshot(options.provider, "Token expired");
  }
  const suffix = options.message?.trim() ? `: ${options.message.trim()}` : "";
  return buildUsageErrorSnapshot(options.provider, `HTTP ${options.status}${suffix}`);
}
