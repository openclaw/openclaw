import type { GuardedFetchResult } from "../../infra/net/fetch-guard.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type { LookupFn, SsrFPolicy } from "../../infra/net/ssrf.js";
export { fetchWithTimeout } from "../../utils/fetch-timeout.js";

const MAX_ERROR_CHARS = 300;

export function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string {
  const raw = baseUrl?.trim() || fallback;
  return raw.replace(/\/+$/, "");
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
  });
}

export async function postTranscriptionRequest(params: {
  url: string;
  headers: Headers;
  body: BodyInit;
  timeoutMs: number;
  fetchFn: typeof fetch;
  allowPrivateNetwork?: boolean;
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
    params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
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
