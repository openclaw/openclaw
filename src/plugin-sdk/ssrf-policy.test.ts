// SSRF policy tests cover URL allow/deny decisions for plugin network helpers.
import { describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../infra/net/ssrf.js";
import {
  resolvePinnedHostnameWithPolicy,
  resolveSsrFPolicyForUrl,
  SsrFBlockedError,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "../infra/net/ssrf.js";
import {
  assertHttpUrlTargetsPrivateNetwork,
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  hasLegacyFlatAllowPrivateNetworkAlias,
  isPrivateNetworkOptInEnabled,
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  mergeSsrFPolicies,
  migrateLegacyFlatAllowPrivateNetworkAlias,
  normalizeHostnameSuffixAllowlist,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  ssrfPolicyFromAllowPrivateNetwork,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "./ssrf-policy.js";

function createLookupFn(addresses: Array<{ address: string; family: number }>): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
}

describe.each([
  ["ssrfPolicyFromDangerouslyAllowPrivateNetwork", ssrfPolicyFromDangerouslyAllowPrivateNetwork],
  ["ssrfPolicyFromAllowPrivateNetwork", ssrfPolicyFromAllowPrivateNetwork],
] as const)("%s", (_policyName, createPolicy) => {
  it.each([
    ["returns undefined for missing input", undefined, undefined],
    ["returns undefined when private-network access is disabled", false, undefined],
    [
      "returns an explicit allow-private-network policy when enabled",
      true,
      { allowPrivateNetwork: true },
    ],
  ])("$0", (_name, input, expected) => {
    expect(createPolicy(input)).toEqual(expected);
  });
});

describe("isPrivateNetworkOptInEnabled", () => {
  it.each([
    ["returns false for missing input", undefined, false],
    ["returns false for explicit false", false, false],
    ["returns true for explicit boolean true", true, true],
    ["returns true for flat allowPrivateNetwork config", { allowPrivateNetwork: true }, true],
    [
      "returns true for flat dangerous opt-in config",
      { dangerouslyAllowPrivateNetwork: true },
      true,
    ],
    [
      "returns true for nested network dangerous opt-in config",
      { network: { dangerouslyAllowPrivateNetwork: true } },
      true,
    ],
    [
      "returns false for nested false values",
      { network: { dangerouslyAllowPrivateNetwork: false } },
      false,
    ],
  ])("$0", (_name, input, expected) => {
    expect(isPrivateNetworkOptInEnabled(input)).toBe(expected);
  });
});

describe("ssrfPolicyFromPrivateNetworkOptIn", () => {
  it.each([
    ["returns undefined for unset input", undefined, undefined],
    ["returns undefined for explicit false input", { allowPrivateNetwork: false }, undefined],
    [
      "returns the compat policy for nested dangerous input",
      { network: { dangerouslyAllowPrivateNetwork: true } },
      { allowPrivateNetwork: true },
    ],
  ])("$0", (_name, input, expected) => {
    expect(ssrfPolicyFromPrivateNetworkOptIn(input)).toEqual(expected);
  });
});

describe("mergeSsrFPolicies", () => {
  it("returns undefined when no policy contributes values", () => {
    expect(mergeSsrFPolicies(undefined, {})).toBeUndefined();
  });

  it("merges boolean flags and dedupes host allowlists", () => {
    expect(
      mergeSsrFPolicies(
        {
          allowPrivateNetwork: true,
          allowedHostnames: ["api.example.com"],
          allowedOrigins: ["http://10.0.0.5:1234"],
          hostnameAllowlist: ["downloads.example.com"],
        },
        {
          dangerouslyAllowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
          allowIpv6UniqueLocalRange: true,
          allowedHostnames: ["api.example.com", "cdn.example.com"],
          allowedOrigins: ["http://10.0.0.5:1234", "http://10.0.0.5:4321"],
          hostnameAllowlist: ["downloads.example.com", "assets.example.com"],
        },
      ),
    ).toEqual({
      allowPrivateNetwork: true,
      dangerouslyAllowPrivateNetwork: true,
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      allowedHostnames: ["api.example.com", "cdn.example.com"],
      allowedOrigins: ["http://10.0.0.5:1234", "http://10.0.0.5:4321"],
      hostnameAllowlist: ["downloads.example.com", "assets.example.com"],
    });
  });
});

describe("legacy private-network alias helpers", () => {
  it("detects the flat allowPrivateNetwork alias", () => {
    expect(hasLegacyFlatAllowPrivateNetworkAlias({ allowPrivateNetwork: true })).toBe(true);
    expect(hasLegacyFlatAllowPrivateNetworkAlias({ network: {} })).toBe(false);
  });

  it("migrates the flat alias into network.dangerouslyAllowPrivateNetwork", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      entry: { allowPrivateNetwork: true },
      pathPrefix: "channels.matrix",
      changes,
    });

    expect(migrated.entry).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(changes).toEqual([
      "Moved channels.matrix.allowPrivateNetwork → channels.matrix.network.dangerouslyAllowPrivateNetwork (true).",
    ]);
  });

  it("prefers the canonical network key when both old and new keys are present", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      entry: {
        allowPrivateNetwork: true,
        network: {
          dangerouslyAllowPrivateNetwork: false,
        },
      },
      pathPrefix: "channels.matrix.accounts.default",
      changes,
    });

    expect(migrated.entry).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: false,
      },
    });
    expect(changes[0]).toContain("(false)");
  });

  it("keeps an explicit canonical true when the legacy key is false", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      entry: {
        allowPrivateNetwork: false,
        network: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
      pathPrefix: "channels.matrix.accounts.default",
      changes,
    });

    expect(migrated.entry).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(changes[0]).toContain("(true)");
  });
});

describe("assertHttpUrlTargetsPrivateNetwork", () => {
  it.each([
    [
      "allows https targets without private-network checks",
      "https://matrix.example.org",
      {
        dangerouslyAllowPrivateNetwork: false,
      },
      "resolve",
      undefined,
    ],
    [
      "allows internal DNS names only when they resolve exclusively to private IPs",
      "http://matrix-synapse:8008",
      {
        dangerouslyAllowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      },
      "resolve",
      undefined,
    ],
    [
      "rejects cleartext public hosts even when private-network access is enabled",
      "http://matrix.example.org:8008",
      {
        dangerouslyAllowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "93.184.216.34", family: 4 }]),
        errorMessage:
          "Matrix homeserver must use https:// unless it targets a private or loopback host",
      },
      "reject",
      "Matrix homeserver must use https:// unless it targets a private or loopback host",
    ],
  ])("$0", async (_name, url, policy, outcome, expectedError) => {
    const result = assertHttpUrlTargetsPrivateNetwork(url, policy);
    if (outcome === "reject") {
      await expect(result).rejects.toThrow(expectedError);
      return;
    }
    await expect(result).resolves.toBeUndefined();
  });

  it("prefers the canonical flag when both canonical and legacy flags are present", async () => {
    await expect(
      assertHttpUrlTargetsPrivateNetwork("http://matrix-synapse:8008", {
        dangerouslyAllowPrivateNetwork: false,
        allowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      }),
    ).rejects.toThrow("HTTP URL must target a trusted private/internal host");
  });

  it("rejects malformed URLs without retaining credential-bearing input", async () => {
    const secretUser = "matrix-user";
    const secretPass = "matrix-fixture";
    const malformed = `http://${secretUser}:${secretPass}@${["invalid", "host"].join(" ")}`;

    const error = await assertHttpUrlTargetsPrivateNetwork(malformed, {
      dangerouslyAllowPrivateNetwork: true,
    }).then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ code: "ERR_INVALID_URL", message: "Invalid URL" });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();

    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(secretUser);
    expect(serialized).not.toContain(secretPass);
  });
});

describe("normalizeHostnameSuffixAllowlist", () => {
  it.each([
    [
      "uses defaults when input is missing",
      undefined,
      ["GRAPH.MICROSOFT.COM"],
      ["graph.microsoft.com"],
    ],
    [
      "normalizes wildcard prefixes and deduplicates",
      ["*.TrafficManager.NET", ".trafficmanager.net.", " * ", "x"],
      undefined,
      ["*"],
    ],
  ])("$0", (_name, input, defaults, expected) => {
    expect(normalizeHostnameSuffixAllowlist(input, defaults)).toEqual(expected);
  });
});

describe("isHttpsUrlAllowedByHostnameSuffixAllowlist", () => {
  it.each([
    ["requires https", "http://a.example.com/x", ["example.com"], false],
    ["supports exact match", "https://example.com/x", ["example.com"], true],
    ["supports suffix match", "https://a.example.com/x", ["example.com"], true],
    ["rejects non-matching hosts", "https://evil.com/x", ["example.com"], false],
    ["supports wildcard allowlist", "https://evil.com/x", ["*"], true],
  ])("$0", (_name, url, allowlist, expected) => {
    expect(isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist)).toBe(expected);
  });
});

describe("buildHostnameAllowlistPolicyFromSuffixAllowlist", () => {
  it.each([
    ["returns undefined when allowHosts is empty", undefined, undefined],
    ["returns undefined for an explicit empty list", [], undefined],
    ["returns undefined when wildcard host is present", ["*"], undefined],
    [
      "returns undefined when wildcard is mixed with concrete hosts",
      ["example.com", "*"],
      undefined,
    ],
    [
      "expands a suffix entry to exact + wildcard hostname allowlist patterns",
      ["sharepoint.com"],
      {
        hostnameAllowlist: ["sharepoint.com", "*.sharepoint.com"],
      },
    ],
    [
      "normalizes wildcard prefixes, leading/trailing dots, and deduplicates patterns",
      ["*.TrafficManager.NET", ".trafficmanager.net.", " blob.core.windows.net "],
      {
        hostnameAllowlist: [
          "trafficmanager.net",
          "*.trafficmanager.net",
          "blob.core.windows.net",
          "*.blob.core.windows.net",
        ],
      },
    ],
  ])("$0", (_name, input, expected) => {
    expect(buildHostnameAllowlistPolicyFromSuffixAllowlist(input)).toEqual(expected);
  });
});

describe("ssrfPolicyFromHttpBaseUrlAllowedOrigin — SDK boundary safety", () => {
  // The constructor itself is permissive: any well-formed http(s) origin
  // becomes a single-entry allowedOrigins policy. The metadata/link-local
  // block lives in the resolver (assertAllowedTrustedHostnameResolvedAddressesOrThrow),
  // so a plugin author's allowedOrigins entry pointing at a metadata target
  // must still be rejected when an actual request goes through the guard.
  it.each([
    ["AWS/EC2 IMDS IPv4 literal", "169.254.169.254", 4, undefined],
    ["Alibaba/100-net metadata IPv4 literal", "100.100.100.200", 4, undefined],
    ["GCP metadata canonical hostname", "metadata.google.internal", 4, "169.254.169.254"],
    ["IPv6 ULA metadata literal", "[fd00:ec2::254]", 6, "fd00:ec2::254"],
    ["non-metadata link-local IPv4 literal", "169.254.42.42", 4, undefined],
  ])(
    "rejects plugin-supplied allowedOrigins entry: $0",
    async (_name, hostname, family, resolvedAddress) => {
      const baseUrl = `http://${hostname}/v1`;
      const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl);
      expect(policy?.allowedOrigins).toEqual([new URL(baseUrl).origin]);

      const policyForUrl = resolveSsrFPolicyForUrl(new URL(baseUrl), policy);
      const lookupAddress = resolvedAddress ?? hostname.replace(/^\[|\]$/g, "");
      await expect(
        resolvePinnedHostnameWithPolicy(hostname, {
          policy: policyForUrl,
          lookupFn: createLookupFn([{ address: lookupAddress, family }]),
        }),
      ).rejects.toThrow(SsrFBlockedError);
    },
  );

  it("rebinding a trusted private origin to a metadata IP is still rejected", async () => {
    const baseUrl = "http://lan-llm.corp.internal:11434/v1";
    const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl);
    const policyForUrl = resolveSsrFPolicyForUrl(new URL(baseUrl), policy);

    await expect(
      resolvePinnedHostnameWithPolicy("lan-llm.corp.internal", {
        policy: policyForUrl,
        lookupFn: createLookupFn([{ address: "169.254.169.254", family: 4 }]),
      }),
    ).rejects.toThrow(SsrFBlockedError);
  });

  it.each([
    ["IPv4 loopback", "127.0.0.1", 4],
    ["IPv6 loopback", "::1", 6],
    ["IPv4-mapped IPv6 loopback", "::ffff:127.0.0.1", 6],
    ["NAT64-embedded IPv4 loopback", "64:ff9b::127.0.0.1", 6],
    ["local-use NAT64", "64:ff9b:1:808:808:808:a9fe:a9fe", 6],
    ["ISATAP-embedded IPv4 loopback", "2001:4860:1::5efe:7f00:1", 6],
  ] as const)("rejects a trusted private origin rebound to %s", async (_name, address, family) => {
    const baseUrl = "http://lan-llm.corp.internal:11434/v1";
    const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl);
    const policyForUrl = resolveSsrFPolicyForUrl(new URL(baseUrl), policy);

    await expect(
      resolvePinnedHostnameWithPolicy("lan-llm.corp.internal", {
        policy: policyForUrl,
        lookupFn: createLookupFn([{ address, family }]),
      }),
    ).rejects.toThrow(SsrFBlockedError);
  });

  it.each([
    ["IPv4 unspecified", "0.0.0.0", 4],
    ["IPv4 unspecified range", "0.42.42.42", 4],
    ["IPv6 unspecified", "::", 6],
    ["IPv4-mapped IPv6 unspecified", "::ffff:0.0.0.0", 6],
    ["NAT64-embedded IPv4 unspecified", "64:ff9b::0.0.0.0", 6],
  ] as const)("rejects a trusted private origin rebound to %s", async (_name, address, family) => {
    const baseUrl = "http://lan-llm.corp.internal:11434/v1";
    const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl);
    const policyForUrl = resolveSsrFPolicyForUrl(new URL(baseUrl), policy);

    await expect(
      resolvePinnedHostnameWithPolicy("lan-llm.corp.internal", {
        policy: policyForUrl,
        lookupFn: createLookupFn([{ address, family }]),
      }),
    ).rejects.toThrow(SsrFBlockedError);
  });

  it.each([
    ["localhost", "127.0.0.1", 4],
    ["localhost.localdomain", "127.0.0.1", 4],
    ["api.localhost", "::1", 6],
    ["127.0.0.1", "127.0.0.1", 4],
    ["[::1]", "::1", 6],
    ["[64:ff9b::127.0.0.1]", "64:ff9b::127.0.0.1", 6],
  ] as const)(
    "allows an explicit %s origin to resolve to loopback",
    async (host, address, family) => {
      const baseUrl = `http://${host}:11434/v1`;
      const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl);
      const policyForUrl = resolveSsrFPolicyForUrl(new URL(baseUrl), policy);
      const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");

      await expect(
        resolvePinnedHostnameWithPolicy(hostname, {
          policy: policyForUrl,
          lookupFn: createLookupFn([{ address, family }]),
        }),
      ).resolves.toBeDefined();
    },
  );
});
