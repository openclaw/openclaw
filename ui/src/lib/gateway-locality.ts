export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    // RFC 6761 section 6.3 reserves localhost and every name under it for loopback, and
    // browsers resolve those origins to this machine (and treat them as secure contexts).
    // The Gateway's own `isExplicitLoopbackHostname` already counts `.localhost` names.
    host.endsWith(".localhost") ||
    ["localhost", "::1", "[::1]"].includes(host) ||
    (/^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every((octet) => Number(octet) <= 255))
  );
}
