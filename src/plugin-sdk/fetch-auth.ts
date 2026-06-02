import {
  normalizeHeadersInitForFetch,
  normalizeRequestInitHeadersForFetch,
} from "../infra/fetch-headers.js";

export type ScopeTokenProvider = {
  /** Return an access token authorized for the exact scope being retried. */
  getAccessToken: (scope: string) => Promise<string>;
};

function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Retry a fetch with bearer tokens from the provided scopes when the unauthenticated attempt fails.
 *
 * The original unauthenticated response stays authoritative if no scoped retry succeeds, which lets
 * callers preserve the server's real status/body instead of surfacing token-provider failures.
 */
export async function fetchWithBearerAuthScopeFallback(params: {
  /** Absolute URL fetched first without auth and then, on eligible failures, with scoped bearer auth. */
  url: string;
  /** Ordered fallback scopes; the first successful scoped fetch wins. */
  scopes: readonly string[];
  tokenProvider?: ScopeTokenProvider;
  fetchFn?: typeof fetch;
  /** Base init reused for both unauthenticated and authenticated attempts after header normalization. */
  requestInit?: RequestInit;
  /** Reject non-HTTPS URLs before the first network call when bearer-token transport must be TLS-only. */
  requireHttps?: boolean;
  /** Host/path guard for callers that only want bearer auth attached to trusted URLs. */
  shouldAttachAuth?: (url: string) => boolean;
  /** Retry classifier; defaults to 401/403 auth failures. */
  shouldRetry?: (response: Response) => boolean;
}): Promise<Response> {
  const fetchFn = params.fetchFn ?? fetch;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error(`Invalid URL: ${params.url}`);
  }
  if (params.requireHttps === true && parsedUrl.protocol !== "https:") {
    throw new Error(`URL must use HTTPS: ${params.url}`);
  }

  const requestInit = normalizeRequestInitHeadersForFetch(params.requestInit);
  const fetchOnce = (headers?: Headers): Promise<Response> =>
    fetchFn(params.url, {
      ...requestInit,
      ...(headers ? { headers } : {}),
    });

  const firstAttempt = await fetchOnce();
  if (firstAttempt.ok) {
    return firstAttempt;
  }
  if (!params.tokenProvider) {
    return firstAttempt;
  }

  const shouldRetry =
    params.shouldRetry ?? ((response: Response) => isAuthFailureStatus(response.status));
  if (!shouldRetry(firstAttempt)) {
    return firstAttempt;
  }
  if (params.shouldAttachAuth && !params.shouldAttachAuth(params.url)) {
    return firstAttempt;
  }

  for (const scope of params.scopes) {
    try {
      const token = await params.tokenProvider.getAccessToken(scope);
      const authHeaders = new Headers(normalizeHeadersInitForFetch(requestInit?.headers));
      authHeaders.set("Authorization", `Bearer ${token}`);
      const authAttempt = await fetchOnce(authHeaders);
      if (authAttempt.ok) {
        return authAttempt;
      }
      if (!shouldRetry(authAttempt)) {
        continue;
      }
    } catch {
      // Ignore token/fetch errors and continue trying remaining scopes.
    }
  }

  return firstAttempt;
}
