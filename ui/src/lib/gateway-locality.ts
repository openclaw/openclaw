// Credential-retry trust intentionally excludes .localhost origins.
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    ["localhost", "::1", "[::1]"].includes(host) ||
    (/^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every((octet) => Number(octet) <= 255))
  );
}

// RFC 6761 loopback delivery only; this must not widen credential-retry trust.
export function isLocalPortalHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || hostname.trim().toLowerCase().endsWith(".localhost");
}
