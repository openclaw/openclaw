import { describe, expect, it, vi } from "vitest";
import { DnsBlocklistError } from "./domain-filter.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import type { LookupFn } from "./ssrf.js";

function createPublicLookupMock(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}

describe("outbound surface catalog spot-check", () => {
  it("web fetch tool path rejects blocked domain with DnsBlocklistError", async () => {
    const lookup = createPublicLookupMock();

    await expect(
      fetchWithSsrFGuard({
        url: "https://malware.test/path",
        lookupFn: lookup,
      }),
    ).rejects.toThrow(DnsBlocklistError);

    // DNS lookup should never be called -- blocklist fires before DNS resolution
    expect(lookup).not.toHaveBeenCalled();
  });
});
