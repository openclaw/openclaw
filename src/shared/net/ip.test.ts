import { describe, expect, it } from "vitest";
import {
  extractEmbeddedIpv4FromIpv6,
  isCanonicalDottedDecimalIPv4,
  isIpInCidr,
  isIpv6Address,
  isLegacyIpv4Literal,
  isPrivateOrLoopbackIpAddress,
  parseCanonicalIpAddress,
} from "./ip.js";

describe("shared ip helpers", () => {
  it("distinguishes canonical dotted IPv4 from legacy forms", () => {
    expect(isCanonicalDottedDecimalIPv4("127.0.0.1")).toBe(true);
    expect(isCanonicalDottedDecimalIPv4("0177.0.0.1")).toBe(false);
    expect(isLegacyIpv4Literal("0177.0.0.1")).toBe(true);
    expect(isLegacyIpv4Literal("127.1")).toBe(true);
    expect(isLegacyIpv4Literal("example.com")).toBe(false);
  });

  it("matches both IPv4 and IPv6 CIDRs", () => {
    expect(isIpInCidr("10.42.0.59", "10.42.0.0/24")).toBe(true);
    expect(isIpInCidr("10.43.0.59", "10.42.0.0/24")).toBe(false);
    expect(isIpInCidr("2001:db8::1234", "2001:db8::/32")).toBe(true);
    expect(isIpInCidr("2001:db9::1234", "2001:db8::/32")).toBe(false);
  });

  it("extracts embedded IPv4 for transition prefixes", () => {
    const cases = [
      ["::ffff:127.0.0.1", "127.0.0.1"],
      ["::127.0.0.1", "127.0.0.1"],
      ["64:ff9b::8.8.8.8", "8.8.8.8"],
      ["64:ff9b:1::10.0.0.1", "10.0.0.1"],
      ["2002:0808:0808::", "8.8.8.8"],
      ["2001::f7f7:f7f7", "8.8.8.8"],
      ["2001:4860:1::5efe:7f00:1", "127.0.0.1"],
    ] as const;
    for (const [ipv6Literal, expectedIpv4] of cases) {
      const parsed = parseCanonicalIpAddress(ipv6Literal);
      expect(parsed?.kind(), ipv6Literal).toBe("ipv6");
      if (!parsed || !isIpv6Address(parsed)) {
        continue;
      }
      expect(extractEmbeddedIpv4FromIpv6(parsed)?.toString(), ipv6Literal).toBe(expectedIpv4);
    }
  });

  it("treats deprecated site-local IPv6 as private/internal", () => {
    expect(isPrivateOrLoopbackIpAddress("fec0::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("2001:4860:4860::8888")).toBe(false);
  });
});
