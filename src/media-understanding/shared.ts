import type {
  ProviderRequestCapability,
  ProviderRequestTransport,
} from "../agents/provider-attribution.js";
import {
  buildProviderRequestDispatcherPolicy,
  normalizeBaseUrl,
  resolveProviderRequestPolicyConfig,
  type ProviderRequestTransportOverrides,
  type ResolvedProviderRequestConfig,
} from "../agents/provider-request-config.js";
import type { GuardedFetchResult } from "../infra/net/fetch-guard.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { LookupFn, PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
export { fetchWithTimeout } from "../utils/fetch-timeout.js";
export { normalizeBaseUrl } from "../agents/provider-request-config.js";

const MAX_ERROR_CHARS = 300;

export function resolveProviderHttpRequestConfig(params: {
  baseUrl?: string;
  defaultBaseUrl: string;
  allowPrivateNetwork?: boolean;
  headers?: HeadersInit;
  defaultHeaders?: Record<string, string>;
  request?: ProviderRequestTransportOverrides;
  provider?: string;
  api?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
}): {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  requestConfig: ResolvedProviderRequestConfig;
} {
  const requestConfig = resolveProviderRequestPolicyConfig({
    provider: params.provider ?? "",
    baseUrl: params.baseUrl,
    defaultBaseUrl: params.defaultBaseUrl,
    capability: params.capability ?? "other",
    transport: params.transport ?? "http",
    callerHeaders: params.headers
      ? Object.fromEntries(new Headers(params.headers).entries())
      : undefined,
    providerHeaders: params.defaultHeaders,
    precedence: "caller-wins",
    allowPrivateNetwork: params.allowPrivateNetwork,
    api: params.api,
    request: params.request,
  });
  const headers = new Headers(requestConfig.headers);
  if (!requestConfig.baseUrl) {
    throw new Error("Missing baseUrl: provide baseUrl or defaultBaseUrl");
  }

  return {
    baseUrl: requestConfig.baseUrl,
    allowPrivateNetwork: requestConfig.allowPrivateNetwork,
    headers,
    dispatcherPolicy: buildProviderRequestDispatcherPolicy(requestConfig),
    requestConfig,
  };
}

export async function fetchWithTimeoutGuarded(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
  options?: {
    ssrfPolicy?: SsrFPolicy;
    lookupFn?: LookupFn;
    pinDns?: boolean;
    dispatcherPolicy?: PinnedDispatcherPolicy;
  },
): Promise<GuardedFetchResult> {
  return await fetchWithSsrFGuard({
    url,
    fetchImpl: fetchFn,
    init,
    timeoutMs,
    policy: options?.ssrfPolicy,
    lookupFn: options?.lookupFn,
    pinDns: options?.pinDns,
    dispatcherPolicy: options?.dispatcherPolicy,
  });
}

export async function postTranscriptionRequest(params: {
  url: string;
  headers: Headers;
  body: BodyInit;
  timeoutMs: number;
  fetchFn: typeof fetch;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}) {
  return fetchWithTimeoutGuarded(
    params.url,
    {
      method: "POST",
      headers: params.headers,
      body: params.body,
    },
    params.timeoutMs,
    params.fetchFn,
    params.allowPrivateNetwork || params.dispatcherPolicy
      ? {
          ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
          ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
        }
      : undefined,
  );
}

export async function postJsonRequest(params: {
  url: string;
  headers: Headers;
  body: unknown;
  timeoutMs: number;
  fetchFn: typeof fetch;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}) {
  return fetchWithTimeoutGuarded(
    params.url,
    {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    params.timeoutMs,
    params.fetchFn,
    params.allowPrivateNetwork || params.dispatcherPolicy
      ? {
          ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
          ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
        }
      : undefined,
  );
}

export async function readErrorResponse(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) {
      return undefined;
    }
    if (collapsed.length <= MAX_ERROR_CHARS) {
      return collapsed;
    }
    return `${collapsed.slice(0, MAX_ERROR_CHARS)}…`;
  } catch {
    return undefined;
  }
}

export async function assertOkOrThrowHttpError(res: Response, label: string): Promise<void> {
  if (res.ok) {
    return;
  }
  const detail = await readErrorResponse(res);
  const suffix = detail ? `: ${detail}` : "";
  throw new Error(`${label} (HTTP ${res.status})${suffix}`);
}

export function requireTranscriptionText(
  value: string | undefined,
  missingMessage: string,
): string {
  const text = value?.trim();
  if (!text) {
    throw new Error(missingMessage);
  }
  return text;
}
