import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  const actualResolvePinnedHostname = ssrf.resolvePinnedHostname;
  const actualResolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;

  const buildPinned = async (hostname: string) => {
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
    if (
      ssrf.isBlockedHostnameOrIp(normalized, params?.policy) ||
      ssrf.isPrivateNetworkAllowedByPolicy(params?.policy)
    ) {
      return await actualResolvePinnedHostnameWithPolicy(hostname, params);
    }
    return await buildPinned(hostname);
  });

  return vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
    if (ssrf.isBlockedHostnameOrIp(normalized)) {
      return await actualResolvePinnedHostname(hostname);
    }
    return await buildPinned(hostname);
  });
}
