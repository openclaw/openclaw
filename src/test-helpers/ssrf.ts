import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  const buildPinnedHostname = (hostname: string) => {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
    const pinnedAddresses = [...addresses];
    return {
      hostname: normalized,
      addresses: pinnedAddresses,
      lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses: pinnedAddresses }),
    };
  };

  const directSpy = vi
    .spyOn(ssrf, "resolvePinnedHostname")
    .mockImplementation(async (hostname) => buildPinnedHostname(hostname));
  const policySpy = vi
    .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
    .mockImplementation(async (hostname) => buildPinnedHostname(hostname));

  return {
    directSpy,
    policySpy,
  };
}
