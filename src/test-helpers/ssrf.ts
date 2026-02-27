import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  const originalResolvePinnedHostname = ssrf.resolvePinnedHostname;
  const originalResolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;

  const buildPinnedHostname = (hostname: string) => {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
    const pinnedAddresses = [...addresses];
    return {
      hostname: normalized,
      addresses: pinnedAddresses,
      lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses: pinnedAddresses }),
    };
  };

  const pinnedSpy = vi
    .spyOn(ssrf, "resolvePinnedHostname")
    .mockImplementation(async (hostname, lookupFn) => {
      if (ssrf.isBlockedHostnameOrIp(hostname)) {
        return originalResolvePinnedHostname(hostname, lookupFn);
      }
      return buildPinnedHostname(hostname);
    });
  vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(async (hostname, params) => {
    if (ssrf.isBlockedHostnameOrIp(hostname, params?.policy)) {
      return originalResolvePinnedHostnameWithPolicy(hostname, params);
    }
    return buildPinnedHostname(hostname);
  });
  return pinnedSpy;
}
