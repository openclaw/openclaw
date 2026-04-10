import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  const resolve = async (hostname: string) => {
    const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.$/, "");
    const pinnedAddresses = [...addresses];
    return {
      hostname: normalized,
      addresses: pinnedAddresses,
      lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses: pinnedAddresses }),
    };
  };
  const pinned = vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(resolve);
  const pinnedWithPolicy = vi
    .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
    .mockImplementation(async (hostname) => resolve(hostname));
  return {
    mockRestore: () => {
      pinned.mockRestore();
      pinnedWithPolicy.mockRestore();
    },
  };
}
