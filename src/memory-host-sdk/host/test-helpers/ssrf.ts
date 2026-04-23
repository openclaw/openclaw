import { vi } from "vitest";
import * as ssrf from "../../../infra/net/ssrf.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";

export function mockPublicPinnedHostname() {
  return vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(async (hostname) => {
    const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.$/, "");
    const addresses = ["93.184.216.34"];
    return {
      hostname: normalized,
      addresses,
      lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
    };
  });
}
