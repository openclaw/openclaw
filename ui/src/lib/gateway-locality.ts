export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    ["localhost", "::1", "[::1]"].includes(host) ||
    (/^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every((octet) => Number(octet) <= 255))
  );
}

/**
 * RFC 6761 §6.3 reserves `localhost` and every name under it for loopback, and the
 * runtime's own `isExplicitLoopbackHostname` counts them. Kept separate from
 * {@link isLoopbackHostname} so credential retry keeps its narrower trust boundary.
 */
export function isLocalhostName(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host === "localhost.localdomain" || host.endsWith(".localhost");
}

/** Whether an origin points at this machine, including RFC 6761 localhost names. */
export function isLoopbackOrLocalhostHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || isLocalhostName(hostname);
}
