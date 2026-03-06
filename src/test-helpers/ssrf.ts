import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  const originalResolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;

  const buildPinned = (hostname: string) => {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
    const pinnedAddresses = [...addresses];
    return {
      hostname: normalized,
      addresses: pinnedAddresses,
      lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses: pinnedAddresses }),
    };
  };

  vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(async (hostname, params) => {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
    // Preserve fail-closed blocking behavior for private/internal hosts without relying on DNS.
    if (ssrf.isBlockedHostnameOrIp(normalized, params?.policy)) {
      return await originalResolvePinnedHostnameWithPolicy(hostname, params);
    }
    return buildPinned(hostname);
  });

  return vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname, lookupFn) => {
    return await ssrf.resolvePinnedHostnameWithPolicy(hostname, { lookupFn });
  });
}
