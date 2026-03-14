import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";

// Store the original implementation before any mocking.
const originalResolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  const fakeLookup = (async () => ({
    address: addresses[0] ?? "93.184.216.34",
    family: (addresses[0] ?? "").includes(":") ? 6 : 4,
  })) as unknown as ssrf.LookupFn;

  const mockImpl = async (hostname: string) => {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
    const pinnedAddresses = [...addresses];
    return {
      hostname: normalized,
      addresses: pinnedAddresses,
      lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses: pinnedAddresses }),
    };
  };

  // Mock resolvePinnedHostnameWithPolicy: delegate to the real implementation
  // with a fake DNS lookup, preserving SSRF policy checks (private IP blocking etc.).
  vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(
    async (hostname, params = {}) => {
      return await originalResolvePinnedHostnameWithPolicy(hostname, {
        ...params,
        lookupFn: fakeLookup,
      });
    },
  );

  return vi
    .spyOn(ssrf, "resolvePinnedHostname")
    .mockImplementation(async (hostname) => mockImpl(hostname));
}
