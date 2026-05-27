import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  return vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
    const pinnedAddresses = [...addresses];
    return {
      hostname: normalized,
      addresses: pinnedAddresses,
      lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses: pinnedAddresses }),
    };
  });
}
