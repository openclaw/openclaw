export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    ["localhost", "localhost.localdomain", "::1", "[::1]"].includes(host) ||
    // RFC 6761 §6.3 reserves localhost and every name under it for loopback; the
    // server-side check already counts these, so the UI must agree.
    host.endsWith(".localhost") ||
    (/^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every((octet) => Number(octet) <= 255))
  );
}
