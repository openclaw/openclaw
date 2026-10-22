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

function resolveAllowedOrigin(baseUrl: string, address: string, family: number) {
  const url = new URL(baseUrl);
  const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl);
  expect(policy?.allowedOrigins).toEqual([url.origin]);
  return resolvePinnedHostnameWithPolicy(url.hostname.replace(/^\[|\]$/g, ""), {
    policy: resolveSsrFPolicyForUrl(url, policy),
    lookupFn: createLookupFn([{ address, family }]),
  });
}

it("ssrfPolicyFromAllowPrivateNetwork returns undefined when disabled", () => {
  expect(ssrfPolicyFromAllowPrivateNetwork(false)).toBeUndefined();
});
const nestedOptIn = { network: { dangerouslyAllowPrivateNetwork: true } };
it("isPrivateNetworkOptInEnabled accepts nested dangerous opt-in config", () => {
  expect(isPrivateNetworkOptInEnabled(nestedOptIn)).toBe(true);
});
it("ssrfPolicyFromPrivateNetworkOptIn returns the compat policy for nested input", () => {
  expect(ssrfPolicyFromPrivateNetworkOptIn(nestedOptIn)).toEqual({ allowPrivateNetwork: true });
});
it("mergeSsrFPolicies returns undefined when no policy contributes values", () => {
  expect(mergeSsrFPolicies(undefined, {})).toBeUndefined();
});

describe("legacy private-network alias helpers", () => {
  it("detects the flat allowPrivateNetwork alias", () => {
    expect(hasLegacyFlatAllowPrivateNetworkAlias({ allowPrivateNetwork: true })).toBe(true);
    expect(hasLegacyFlatAllowPrivateNetworkAlias({ network: {} })).toBe(false);
  });

  it("prefers the canonical network key when both old and new keys are present", () => {
    const changes: string[] = [];
    const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
      entry: {
        allowPrivateNetwork: true,
        network: { dangerouslyAllowPrivateNetwork: false },
      },
      pathPrefix: "channels.matrix.accounts.default",
      changes,
    });

    expect(migrated.entry).toEqual({ network: { dangerouslyAllowPrivateNetwork: false } });
    expect(changes[0]).toContain("(false)");
  });
});

describe("assertHttpUrlTargetsPrivateNetwork", () => {
  it("allows https targets without private-network checks", async () => {
    await expect(
      assertHttpUrlTargetsPrivateNetwork("https://matrix.example.org", {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects cleartext public hosts even when private-network access is enabled", async () => {
    const errorMessage =
      "Matrix homeserver must use https:// unless it targets a private or loopback host";
    await expect(
      assertHttpUrlTargetsPrivateNetwork("http://matrix.example.org:8008", {
        dangerouslyAllowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "93.184.216.34", family: 4 }]),
        errorMessage,
      }),
    ).rejects.toThrow(errorMessage);
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

it("normalizeHostnameSuffixAllowlist normalizes wildcard prefixes and deduplicates", () => {
  expect(
    normalizeHostnameSuffixAllowlist(["*.TrafficManager.NET", ".trafficmanager.net.", " * ", "x"]),
  ).toEqual(["*"]);
});
it.each([
  ["supports suffix match", "https://a.example.com/x", ["example.com"], true],
  ["supports wildcard allowlist", "https://evil.com/x", ["*"], true],
])("isHttpsUrlAllowedByHostnameSuffixAllowlist $0", (_name, url, allowlist, expected) => {
  expect(isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist)).toBe(expected);
});
it.each([
  ["returns undefined for an explicit empty list", [], undefined],
  ["returns undefined when wildcard is mixed with concrete hosts", ["example.com", "*"], undefined],
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
])("buildHostnameAllowlistPolicyFromSuffixAllowlist $0", (_name, input, expected) => {
  expect(buildHostnameAllowlistPolicyFromSuffixAllowlist(input)).toEqual(expected);
});

describe("ssrfPolicyFromHttpBaseUrlAllowedOrigin — SDK boundary safety", () => {
  // allowedOrigins must not bypass metadata/link-local rejection at resolution.
  it.each([
    ["AWS/EC2 IMDS IPv4 literal", "169.254.169.254", 4, undefined],
    ["GCP metadata canonical hostname", "metadata.google.internal", 4, "169.254.169.254"],
    ["non-metadata link-local IPv4 literal", "169.254.42.42", 4, undefined],
  ])(
    "rejects plugin-supplied allowedOrigins entry: $0",
    async (_name, hostname, family, resolvedAddress) => {
      await expect(
        resolveAllowedOrigin(`http://${hostname}/v1`, resolvedAddress ?? hostname, family),
      ).rejects.toThrow(SsrFBlockedError);
    },
  );

  it.each([
    ["IPv4 loopback", "127.0.0.1", 4],
    ["IPv6 loopback", "::1", 6],
    ["IPv4-mapped IPv6 loopback", "::ffff:127.0.0.1", 6],
    ["NAT64-embedded IPv4 loopback", "64:ff9b::127.0.0.1", 6],
    ["local-use NAT64", "64:ff9b:1:808:808:808:a9fe:a9fe", 6],
    ["ISATAP-embedded IPv4 loopback", "2001:4860:1::5efe:7f00:1", 6],
    ["IPv4 unspecified", "0.0.0.0", 4],
  ] as const)("rejects a trusted private origin rebound to %s", async (_name, address, family) => {
    await expect(
      resolveAllowedOrigin("http://lan-llm.corp.internal:11434/v1", address, family),
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
      await expect(
        resolveAllowedOrigin(`http://${host}:11434/v1`, address, family),
      ).resolves.toBeDefined();
    },
  );
});
