/**
 * True when the hostname is the loopback interface under a name that may also be trusted with
 * stored credentials. Kept strict: `.localhost` names are loopback for delivery, but they are a
 * different origin, so `isTrustedRetryEndpoint` must not treat them as the same endpoint.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    ["localhost", "::1", "[::1]"].includes(host) ||
    (/^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every((octet) => Number(octet) <= 255))
  );
}

/**
 * True when a URL origin points at this machine for delivery purposes. RFC 6761 section 6.3
 * reserves `localhost` and every name under it for loopback, and the Gateway's own
 * `isExplicitLoopbackHostname` counts those names, so the Portals page must agree.
 */
export function isLocalPortalHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || hostname.trim().toLowerCase().endsWith(".localhost");
}
