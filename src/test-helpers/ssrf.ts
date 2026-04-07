import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  return vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
    const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.$/, "");
    const pinnedAddresses = [...addresses];
    return {
      hostname: normalized,
      addresses: pinnedAddresses,
      lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses: pinnedAddresses }),
    };
  });
}
