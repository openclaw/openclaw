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
  isPrivateNetworkOptInEnabled,
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  mergeSsrFPolicies,
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

async function expectAllowedOrigin(
  baseUrl: string,
  address: string,
  family: number,
  allowed: boolean,
) {
  const url = new URL(baseUrl);
  const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl);
  expect(policy?.allowedOrigins).toEqual([url.origin]);
  const result = resolvePinnedHostnameWithPolicy(url.hostname.replace(/^\[|\]$/g, ""), {
    policy: resolveSsrFPolicyForUrl(url, policy),
    lookupFn: createLookupFn([{ address, family }]),
  });
  if (allowed) {
    await expect(result).resolves.toBeDefined();
  } else {
    await expect(result).rejects.toThrow(SsrFBlockedError);
  }
}

it("ssrfPolicyFromAllowPrivateNetwork returns undefined when disabled", () => {
  expect(ssrfPolicyFromAllowPrivateNetwork(false)).toBeUndefined();
});
const nestedOptIn = { network: { dangerouslyAllowPrivateNetwork: true } };
it("isPrivateNetworkOptInEnabled accepts nested dangerous opt-in config", () => {
  expect(isPrivateNetworkOptInEnabled(nestedOptIn)).toBe(true);
});
it("ssrfPolicyFromPrivateNetworkOptIn returns the compat policy for nested input", () => {
  expect(
    ssrfPolicyFromPrivateNetworkOptIn({ network: { dangerouslyAllowPrivateNetwork: true } }),
  ).toEqual({ allowPrivateNetwork: true });
});
it("mergeSsrFPolicies returns undefined when no policy contributes values", () => {
  expect(mergeSsrFPolicies(undefined, {})).toBeUndefined();
});

describe("assertHttpUrlTargetsPrivateNetwork", () => {
  it.each([
    ["https://matrix.example.org", false, undefined, "10.0.0.5", undefined],
    ["http://matrix.example.org:8008", true, undefined, "93.184.216.34", "custom error"],
    [
      "http://matrix-synapse:8008",
      false,
      true,
      "10.0.0.5",
      "HTTP URL must target a trusted private/internal host",
    ],
  ] as const)(
    "applies canonical private-network policy to %s",
    async (url, canonical, legacy, address, error) => {
      const result = assertHttpUrlTargetsPrivateNetwork(url, {
        dangerouslyAllowPrivateNetwork: canonical,
        allowPrivateNetwork: legacy,
        lookupFn: createLookupFn([{ address, family: 4 }]),
        ...(canonical ? { errorMessage: error } : {}),
      });
      if (error) {
        await expect(result).rejects.toThrow(error);
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    },
  );

  it("rejects malformed URLs without retaining credential-bearing input", async () => {
    const invalid = "http://matrix-user:matrix-fixture@invalid host";
    const error = await assertHttpUrlTargetsPrivateNetwork(invalid, {
      dangerouslyAllowPrivateNetwork: true,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ code: "ERR_INVALID_URL", message: "Invalid URL" });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();

    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toMatch(/matrix-user|matrix-fixture/);
  });
});

it("normalizeHostnameSuffixAllowlist normalizes wildcard prefixes and deduplicates", () => {
  expect(
    normalizeHostnameSuffixAllowlist(["*.TrafficManager.NET", ".trafficmanager.net.", " * ", "x"]),
  ).toEqual(["*"]);
});
it.each([
  ["https://a.example.com/x", ["example.com"]],
  ["https://evil.com/x", ["*"]],
])("allows HTTPS suffix match: %s via %j", (url, allowlist) => {
  expect(isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist)).toBe(true);
});
it.each([
  ["empty", [], undefined],
  ["wildcard", ["example.com", "*"], undefined],
  [
    "normalized",
    [" *.Example.COM ", ".example.com."],
    { hostnameAllowlist: ["example.com", "*.example.com"] },
  ],
])("builds hostname policy: %s", (_name, input, expected) => {
  expect(buildHostnameAllowlistPolicyFromSuffixAllowlist(input)).toEqual(expected);
});

const privateHost = "lan-llm.corp.internal";
it.each([
  ["169.254.169.254", "169.254.169.254", 4, false],
  ["metadata.google.internal", "169.254.169.254", 4, false],
  ["169.254.42.42", "169.254.42.42", 4, false],
  [privateHost, "127.0.0.1", 4, false],
  [privateHost, "::1", 6, false],
  [privateHost, "::ffff:127.0.0.1", 6, false],
  [privateHost, "64:ff9b::127.0.0.1", 6, false],
  [privateHost, "64:ff9b:1:808:808:808:a9fe:a9fe", 6, false],
  [privateHost, "2001:4860:1::5efe:7f00:1", 6, false],
  [privateHost, "0.0.0.0", 4, false],
  ["localhost", "127.0.0.1", 4, true],
  ["localhost.localdomain", "127.0.0.1", 4, true],
  ["api.localhost", "::1", 6, true],
  ["127.0.0.1", "127.0.0.1", 4, true],
  ["[::1]", "::1", 6, true],
  ["[64:ff9b::127.0.0.1]", "64:ff9b::127.0.0.1", 6, true],
] as const)("origin %s -> %s (IPv%s): allowed=%s", (host, address, family, allowed) =>
  expectAllowedOrigin(`http://${host}:11434/v1`, address, family, allowed),
);
