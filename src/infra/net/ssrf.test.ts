// SSRF tests cover IP privacy classification and HTTP base URL policy builders.
import { describe, expect, it } from "vitest";
import { blockedIpv6MulticastLiterals } from "../../../packages/net-policy/src/ip-test-fixtures.js";
import {
  assertHostnameAllowedWithPolicy,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  isSameSsrFPolicy,
  mergeSsrFPolicies,
  resolveSsrFPolicyForUrl,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
} from "./ssrf.js";

const privateIpCases = [
  "198.18.0.1",
  "198.19.255.254",
  "198.51.100.42",
  "203.0.113.10",
  "192.0.0.8",
  "192.0.2.1",
  "192.88.99.1",
  "224.0.0.1",
  "239.255.255.255",
  "240.0.0.1",
  "255.255.255.255",
  "::ffff:127.0.0.1",
  "::ffff:198.18.0.1",
  "64:ff9b::198.51.100.42",
  "0:0:0:0:0:ffff:7f00:1",
  "0000:0000:0000:0000:0000:ffff:7f00:0001",
  "::127.0.0.1",
  "0:0:0:0:0:0:7f00:1",
  "[0:0:0:0:0:ffff:7f00:1]",
  "::ffff:169.254.169.254",
  "0:0:0:0:0:ffff:a9fe:a9fe",
  "64:ff9b::127.0.0.1",
  "64:ff9b::169.254.169.254",
  "64:ff9b:1:c0a8:1:100::",
  "64:ff9b:1:a00:0:100::",
  "64:ff9b:1::8.8.8.8",
  "64:ff9b:1:808:808:808:808:808",
  "64:ff9b:1:808:808:808:a9fe:a9fe",
  "2002:7f00:0001::",
  "2002:a9fe:a9fe::",
  "2001:0000:0:0:0:0:80ff:fefe",
  "2001:0000:0:0:0:0:3f57:fefe",
  "2002:c612:0001::",
  "::",
  "::1",
  "fe80::1%lo0",
  "fd00::1",
  "fec0::1",
  "100::1",
  ...blockedIpv6MulticastLiterals,
  "2001:2::1",
  "2001:20::1",
  "2001:db8::1",
  "2001:db8:1234::5efe:127.0.0.1",
  "2001:db8:1234:1:200:5efe:7f00:1",
];

const malformedIpv6Cases = ["::::", "2001:db8::gggg"];
const unsupportedLegacyIpv4Cases = [
  "0177.0.0.1",
  "0x7f.0.0.1",
  "127.1",
  "2130706433",
  "0x7f000001",
  "017700000001",
  "8.8.2056",
  "0x08080808",
  "08.0.0.1",
  "0x7g.0.0.1",
  "127..0.1",
  "999.1.1.1",
];

function expectIpPrivacyCases(cases: string[], expected: boolean) {
  for (const address of cases) {
    expect(isPrivateIpAddress(address)).toBe(expected);
  }
}

const httpBaseUrlPolicyBuilders = [
  {
    name: "ssrfPolicyFromHttpBaseUrlAllowedHostname",
    build: ssrfPolicyFromHttpBaseUrlAllowedHostname,
  },
  {
    name: "ssrfPolicyFromHttpBaseUrlAllowedOrigin",
    build: ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  },
  {
    name: "ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist",
    build: ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
  },
];

describe("ssrf ip classification", () => {
  it("classifies blocked ip literals as private", () => {
    expectIpPrivacyCases(
      [...privateIpCases, ...malformedIpv6Cases, ...unsupportedLegacyIpv4Cases],
      true,
    );
  });
});

describe("HTTP base URL SSRF policy builders", () => {
  it.each(httpBaseUrlPolicyBuilders)(
    "$name ignores empty, invalid, and non-HTTP URLs",
    ({ build }) => {
      expect(build("")).toBeUndefined();
      expect(build("not-a-url")).toBeUndefined();
      expect(build("ftp://api.example.com")).toBeUndefined();
    },
  );
});

describe("ssrfPolicyFromHttpBaseUrlAllowedHostname", () => {
  it("builds an allowed-hostname policy from HTTP base URLs", () => {
    expect(ssrfPolicyFromHttpBaseUrlAllowedHostname(" https://api.example.com/v1 ")).toEqual({
      allowedHostnames: ["api.example.com"],
    });
  });
});

describe("ssrfPolicyFromHttpBaseUrlAllowedOrigin", () => {
  it("builds an allowed-origin policy from HTTP base URLs", () => {
    expect(ssrfPolicyFromHttpBaseUrlAllowedOrigin(" http://10.0.0.5:1234/v1 ")).toEqual({
      allowedOrigins: ["http://10.0.0.5:1234"],
    });
    expect(
      ssrfPolicyFromHttpBaseUrlAllowedOrigin("https://api.example.com/v1?token=redacted"),
    ).toEqual({
      allowedOrigins: ["https://api.example.com"],
    });
  });
});

describe("resolveSsrFPolicyForUrl", () => {
  it("does not trust the hostname when the port differs", () => {
    expect(
      resolveSsrFPolicyForUrl(new URL("http://10.0.0.5:4321/v1/chat/completions"), {
        allowedOrigins: ["http://10.0.0.5:1234"],
      }),
    ).toEqual({
      allowedOrigins: ["http://10.0.0.5:1234"],
    });
  });

  it("supports IPv6 origins when the exact origin matches", () => {
    expect(
      resolveSsrFPolicyForUrl(new URL("http://[fd00::1]:11434/v1/chat/completions"), {
        allowedOrigins: ["http://[fd00::1]:11434"],
      }),
    ).toEqual({
      allowedOrigins: ["http://[fd00::1]:11434"],
      allowedHostnames: ["fd00::1"],
    });
  });
});

describe("ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist", () => {
  it("builds a host-scoped fake-IP policy from HTTP base URLs", () => {
    expect(
      ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(" https://api.example.com/v1 "),
    ).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["api.example.com"],
    });
  });
});

describe("isBlockedHostnameOrIp", () => {
  it.each(["db.internal..."])(
    "blocks reserved hostname with repeated trailing dots %s",
    (hostname) => {
      expect(isBlockedHostnameOrIp(hostname)).toBe(true);
      expect(() => assertHostnameAllowedWithPolicy(hostname)).toThrow(/blocked/i);
    },
  );

  it.each([["::ffff:198.18.0.1", { allowRfc2544BenchmarkRange: true }, false]] as const)(
    "applies RFC2544 benchmark policy for %s",
    (value, policy, expected) => {
      expect(isBlockedHostnameOrIp(value, policy)).toBe(expected);
    },
  );

  // #74351: fake-ip proxy stacks (sing-box / Clash / Surge) resolve foreign
  // domains to BOTH IPv4 198.18.0.0/15 AND IPv6 fc00::/7 simultaneously.
  // The policy must let operators opt into the IPv6 ULA range
  // independently of the IPv4 benchmark exemption.
  it.each([
    ["fdff::dead:beef", { allowIpv6UniqueLocalRange: true }, false],
    ["198.18.0.1", { allowIpv6UniqueLocalRange: true }, true],
  ] as const)("applies IPv6 unique-local policy for %s", (value, policy, expected) => {
    expect(isBlockedHostnameOrIp(value, policy)).toBe(expected);
  });
});

describe("isSameSsrFPolicy", () => {
  it("compares policy fields semantically", () => {
    expect(
      isSameSsrFPolicy(
        {
          allowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
          allowedOrigins: ["https://A.example.com/v1", "https://b.example.com"],
          allowedHostnames: ["b.example.com", "A.example.com"],
          hostnameAllowlist: ["*.example.com", "api.example.com"],
          blockedHostnames: ["tracker.example.com", " *.ADS.example.com. ", "tracker.example.com"],
        },
        {
          allowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
          allowedOrigins: ["https://b.example.com", "https://a.example.com/other"],
          allowedHostnames: ["a.example.com", "B.EXAMPLE.COM"],
          hostnameAllowlist: ["api.example.com", "*.example.com"],
          blockedHostnames: ["*.ads.example.com", "TRACKER.example.com"],
        },
      ),
    ).toBe(true);

    expect(isSameSsrFPolicy({}, { blockedHostnames: [] })).toBe(true);
    expect(isSameSsrFPolicy({}, { blockedHostnames: ["tracker.example.com"] })).toBe(false);
    expect(
      isSameSsrFPolicy(
        { blockedHostnames: ["tracker.example.com"] },
        { blockedHostnames: ["*.example.com"] },
      ),
    ).toBe(false);

    expect(
      isSameSsrFPolicy(
        { dangerouslyAllowPrivateNetwork: true },
        { dangerouslyAllowPrivateNetwork: true, allowRfc2544BenchmarkRange: true },
      ),
    ).toBe(false);

    // #74351: the new `allowIpv6UniqueLocalRange` flag must participate in
    // semantic equality. Otherwise consumers caching policy objects keyed by
    // `isSameSsrFPolicy` would silently reuse a stale fc00::/7-blocking
    // policy after the flag was flipped on.
    expect(
      isSameSsrFPolicy(
        { allowPrivateNetwork: true },
        { allowPrivateNetwork: true, allowIpv6UniqueLocalRange: true },
      ),
    ).toBe(false);
    expect(
      isSameSsrFPolicy({ allowIpv6UniqueLocalRange: true }, { allowIpv6UniqueLocalRange: true }),
    ).toBe(true);
  });
});

describe("mergeSsrFPolicies", () => {
  it("retains every configured block when combining policies and trust exceptions", () => {
    const policy = mergeSsrFPolicies(
      { blockedHostnames: ["tracker.example.com"] },
      undefined,
      { blockedHostnames: [] },
      {
        blockedHostnames: ["*.ads.example.com", "tracker.example.com"],
        allowedHostnames: ["tracker.example.com"],
      },
    );
    expect(policy?.blockedHostnames).toEqual(["tracker.example.com", "*.ads.example.com"]);
    for (const hostname of ["tracker.example.com", "pixel.ads.example.com"]) {
      expect(() => assertHostnameAllowedWithPolicy(hostname, policy)).toThrow(
        /configured blocklist/,
      );
    }
  });
});
