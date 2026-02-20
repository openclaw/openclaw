/**
 * SSRF (Server-Side Request Forgery) guard – convenience layer.
 *
 * Delegates to the battle-tested primitives in src/infra/net/ssrf.ts
 * for IP validation, hostname blocking, and DNS-pinned resolution.
 *
 * Exports:
 * - {@link validateUrl} – one-shot URL check (protocol, hostname, resolved IPs).
 * - {@link safeFetch}   – end-to-end guarded fetch with DNS pinning so the
 *   resolved addresses cannot change between validation and the HTTP request
 *   (prevents DNS rebinding / TOCTOU attacks).
 * - Re-exports of the underlying {@link isPrivateIpAddress},
 *   {@link isBlockedHostname}, and {@link SsrFBlockedError} for direct use.
 */

import { isIP } from "node:net";
import {
  isPrivateIpAddress,
  isBlockedHostname,
  SsrFBlockedError,
  type LookupFn,
  resolvePinnedHostnameWithPolicy,
} from "../infra/net/ssrf.js";
import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
} from "../infra/net/fetch-guard.js";

// Re-export canonical implementations so consumers can use a single import.
export { isPrivateIpAddress, isBlockedHostname, SsrFBlockedError };
export type { GuardedFetchResult };

/** Allowed URL protocols. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validate a URL for outbound requests without making the request.
 *
 * Checks the protocol, hostname (including `localhost`, `.local`, `.internal`),
 * and resolves DNS to verify all addresses are public. The DNS result is
 * **not pinned** to a subsequent request, so this function is suitable for
 * pre-flight validation only. For end-to-end protection (including DNS
 * rebinding), use {@link safeFetch} instead.
 *
 * @throws {SsrFBlockedError} if the URL targets a private resource.
 */
export async function validateUrl(rawUrl: string, lookupFn?: LookupFn): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrFBlockedError(`invalid URL: ${rawUrl}`);
  }

  // Protocol check
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SsrFBlockedError(`protocol not allowed: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new SsrFBlockedError("URL has no hostname");
  }

  // Strip IPv6 brackets for checks
  const cleanHost = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

  // Blocked hostname patterns (localhost, .local, .internal, metadata.google.internal)
  if (isBlockedHostname(cleanHost)) {
    throw new SsrFBlockedError(`blocked hostname: ${cleanHost}`);
  }

  // If the hostname is already an IP literal, validate directly
  if (isIP(cleanHost)) {
    if (isPrivateIpAddress(cleanHost)) {
      throw new SsrFBlockedError(`private/internal IP blocked: ${cleanHost}`);
    }
    return;
  }

  // Resolve DNS and validate all addresses.
  // resolvePinnedHostnameWithPolicy throws SsrFBlockedError for private IPs.
  await resolvePinnedHostnameWithPolicy(hostname, {
    ...(lookupFn ? { lookupFn } : {}),
  });
}

/**
 * Fetch a URL with full SSRF protection and DNS pinning.
 *
 * This is the recommended entry point for making outbound HTTP requests.
 * It resolves DNS once, validates all addresses, then pins the HTTP
 * connection to the validated IPs — preventing DNS rebinding / TOCTOU
 * attacks.
 *
 * The caller **must** call `result.release()` when done with the response.
 *
 * @throws {SsrFBlockedError} if the URL targets a private resource.
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
  options?: Partial<Pick<GuardedFetchOptions, "maxRedirects" | "timeoutMs" | "signal" | "lookupFn" | "auditContext">>,
): Promise<GuardedFetchResult> {
  return fetchWithSsrFGuard({
    url,
    init,
    pinDns: true,
    ...options,
  });
}
