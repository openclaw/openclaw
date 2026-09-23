import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type { TlsOptions } from "node:tls";

/** Select a certificate-valid direct hostname without changing the listener or client URL. */
export function resolvePortalTlsHostname(
  tlsOptions: TlsOptions,
  gatewayOrigins: readonly string[],
  fallbackHost: string,
): string {
  const material = Array.isArray(tlsOptions.cert) ? tlsOptions.cert[0] : tlsOptions.cert;
  if (!material) {
    return fallbackHost;
  }
  const certificate = new X509Certificate(material);
  const candidates: string[] = [];
  for (const origin of gatewayOrigins) {
    try {
      candidates.push(new URL(origin).hostname.replace(/^\[|\]$/gu, ""));
    } catch {
      // Origin allowlists can contain non-URL entries such as "*".
    }
  }
  candidates.push(fallbackHost.replace(/^\[|\]$/gu, ""));
  // A wildcard cannot supply a concrete destination. Verify every extracted name
  // against the certificate rather than treating SAN display text as authority.
  for (const match of (certificate.subjectAltName ?? "").matchAll(
    /(?:^|, )DNS:([a-z0-9.-]+)(?=, |$)/giu,
  )) {
    if (match[1]) {
      candidates.push(match[1]);
    }
  }
  for (const candidate of candidates) {
    const matches = isIP(candidate)
      ? certificate.checkIP(candidate)
      : certificate.checkHost(candidate, { subject: "never" });
    if (matches) {
      return candidate.includes(":") ? `[${candidate}]` : candidate;
    }
  }
  // Self-signed/default material may have no DNS identity. Preserve its direct
  // address instead of guessing a hostname or silently changing ingress modes.
  return fallbackHost;
}
