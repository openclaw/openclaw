// Host guard for remote MEDIA: URLs. Hostname rules run here without an IP parser;
// anything an IP parser could read is delegated to the full guard, built from
// @openclaw/net-policy/ip. Until that guard is installed, IP-shaped hosts are rejected.
// parse-output.ts installs it at import; the browser installs it on demand.
import type * as NetPolicyIp from "@openclaw/net-policy/ip";

/** Classifies a normalized host that may be an IP literal; true means blocked. */
type RemoteMediaIpHostnameGuard = (normalizedHostname: string) => boolean;

let ipHostnameGuard: RemoteMediaIpHostnameGuard | undefined;
let deferredIpHostnameRejections = 0;

// Labels the IP parsers accept: decimal, octal-looking digits, and 0x hex.
const IP_LITERAL_LABEL_RE = /^(?:[0-9]+|0x[0-9a-f]+)$/i;
// Anything outside this set (":", "[", "%", whitespace, other punctuation) goes to the full guard.
const PLAIN_HOSTNAME_RE = /^[a-z0-9._-]+$/;

/** Lowercases, strips brackets and trailing dots; empty means the host is malformed. */
function normalizeRemoteMediaHostname(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (normalized.split(".").some((label) => label.length === 0)) {
    return "";
  }
  return normalized;
}

/**
 * False only when no canonical, loose or legacy IP parse can succeed: the host uses
 * plain hostname characters and at least one label is not a decimal or 0x number.
 */
function mayBeRemoteMediaIpHostname(normalized: string): boolean {
  return (
    !PLAIN_HOSTNAME_RE.test(normalized) ||
    normalized.split(".").every((label) => IP_LITERAL_LABEL_RE.test(label))
  );
}

/** Hostname-only rules, valid for hosts where mayBeRemoteMediaIpHostname is false. */
function isBlockedRemoteMediaDomainName(normalized: string): boolean {
  return (
    !normalized.includes(".") ||
    normalized === "localhost.localdomain" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

/** Full guard for a normalized host, including IP literal parsing; true means blocked. */
export function createRemoteMediaIpHostnameGuard(
  ip: typeof NetPolicyIp,
): RemoteMediaIpHostnameGuard {
  return (normalized) => {
    const strictIp = ip.parseCanonicalIpAddress(normalized);
    if (strictIp) {
      if (ip.isIpv4Address(strictIp)) {
        return ip.isBlockedSpecialUseIpv4Address(strictIp);
      }
      if (ip.isBlockedSpecialUseIpv6Address(strictIp)) {
        return true;
      }
      const embeddedIpv4 = ip.extractEmbeddedIpv4FromIpv6(strictIp);
      return embeddedIpv4 ? ip.isBlockedSpecialUseIpv4Address(embeddedIpv4) : false;
    }
    if (isBlockedRemoteMediaDomainName(normalized)) {
      return true;
    }

    if (normalized.includes(":") && !ip.parseLooseIpAddress(normalized)) {
      return true;
    }
    return !ip.isCanonicalDottedDecimalIPv4(normalized) && ip.isLegacyIpv4Literal(normalized);
  };
}

export function installRemoteMediaIpHostnameGuard(guard: RemoteMediaIpHostnameGuard): void {
  ipHostnameGuard = guard;
}

export function hasRemoteMediaIpHostnameGuard(): boolean {
  return ipHostnameGuard !== undefined;
}

/** Counts IP-shaped hosts rejected only because the full guard was not loaded yet. */
export function readDeferredRemoteMediaIpHostnameRejections(): number {
  return deferredIpHostnameRejections;
}

export function isBlockedRemoteMediaHostname(hostname: string): boolean {
  const normalized = normalizeRemoteMediaHostname(hostname);
  if (!normalized) {
    return true;
  }
  if (!mayBeRemoteMediaIpHostname(normalized)) {
    return isBlockedRemoteMediaDomainName(normalized);
  }
  if (ipHostnameGuard) {
    return ipHostnameGuard(normalized);
  }
  // Fail closed until the full guard is installed; never accept a host it has not seen.
  deferredIpHostnameRejections += 1;
  return true;
}
