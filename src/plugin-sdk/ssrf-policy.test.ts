import { describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../infra/net/ssrf.js";
import {
  assertHttpUrlTargetsPrivateNetwork,
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  normalizeHostnameSuffixAllowlist,
  ssrfPolicyFromAllowPrivateNetwork,
} from "./ssrf-policy.js";

function createLookupFn(addresses: Array<{ address: string; family: number }>): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
}

describe("ssrfPolicyFromAllowPrivateNetwork", () => {
  it("returns undefined unless private-network access is explicitly enabled", () => {
    expect(ssrfPolicyFromAllowPrivateNetwork(undefined)).toBeUndefined();
    expect(ssrfPolicyFromAllowPrivateNetwork(false)).toBeUndefined();
    expect(ssrfPolicyFromAllowPrivateNetwork(true)).toEqual({ allowPrivateNetwork: true });
  });
});

describe("assertHttpUrlTargetsPrivateNetwork", () => {
  it("allows https targets without private-network checks", async () => {
    await expect(
      assertHttpUrlTargetsPrivateNetwork("https://matrix.example.org", {
        allowPrivateNetwork: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("allows internal DNS names only when they resolve exclusively to private IPs", async () => {
    await expect(
      assertHttpUrlTargetsPrivateNetwork("http://matrix-synapse:8008", {
        allowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "10.0.0.5", family: 4 }]),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects cleartext public hosts even when private-network access is enabled", async () => {
    await expect(
      assertHttpUrlTargetsPrivateNetwork("http://matrix.example.org:8008", {
        allowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "93.184.216.34", family: 4 }]),
        errorMessage:
          "Matrix homeserver must use https:// unless it targets a private or loopback host",
      }),
    ).rejects.toThrow(
      "Matrix homeserver must use https:// unless it targets a private or loopback host",
    );
  });
});

describe("normalizeHostnameSuffixAllowlist", () => {
  it("uses defaults when input is missing", () => {
    expect(normalizeHostnameSuffixAllowlist(undefined, ["GRAPH.MICROSOFT.COM"])).toEqual([
      "graph.microsoft.com",
    ]);
  });

  it("normalizes wildcard prefixes and deduplicates", () => {
    expect(
      normalizeHostnameSuffixAllowlist([
        "*.TrafficManager.NET",
        ".trafficmanager.net.",
        " * ",
        "x",
      ]),
    ).toEqual(["*"]);
  });
});

describe("isHttpsUrlAllowedByHostnameSuffixAllowlist", () => {
  it("requires https", () => {
    expect(
      isHttpsUrlAllowedByHostnameSuffixAllowlist("http://a.example.com/x", ["example.com"]),
    ).toBe(false);
  });

  it("supports exact and suffix match", () => {
    expect(
      isHttpsUrlAllowedByHostnameSuffixAllowlist("https://example.com/x", ["example.com"]),
    ).toBe(true);
    expect(
      isHttpsUrlAllowedByHostnameSuffixAllowlist("https://a.example.com/x", ["example.com"]),
    ).toBe(true);
    expect(isHttpsUrlAllowedByHostnameSuffixAllowlist("https://evil.com/x", ["example.com"])).toBe(
      false,
    );
  });

  it("supports wildcard allowlist", () => {
    expect(isHttpsUrlAllowedByHostnameSuffixAllowlist("https://evil.com/x", ["*"])).toBe(true);
  });
});

describe("buildHostnameAllowlistPolicyFromSuffixAllowlist", () => {
  it("returns undefined when allowHosts is empty", () => {
    expect(buildHostnameAllowlistPolicyFromSuffixAllowlist()).toBeUndefined();
    expect(buildHostnameAllowlistPolicyFromSuffixAllowlist([])).toBeUndefined();
  });

  it("returns undefined when wildcard host is present", () => {
    expect(buildHostnameAllowlistPolicyFromSuffixAllowlist(["*"])).toBeUndefined();
    expect(buildHostnameAllowlistPolicyFromSuffixAllowlist(["example.com", "*"])).toBeUndefined();
  });

  it("expands a suffix entry to exact + wildcard hostname allowlist patterns", () => {
    expect(buildHostnameAllowlistPolicyFromSuffixAllowlist(["sharepoint.com"])).toEqual({
      hostnameAllowlist: ["sharepoint.com", "*.sharepoint.com"],
    });
  });

  it("normalizes wildcard prefixes, leading/trailing dots, and deduplicates patterns", () => {
    expect(
      buildHostnameAllowlistPolicyFromSuffixAllowlist([
        "*.TrafficManager.NET",
        ".trafficmanager.net.",
        " blob.core.windows.net ",
      ]),
    ).toEqual({
      hostnameAllowlist: [
        "trafficmanager.net",
        "*.trafficmanager.net",
        "blob.core.windows.net",
        "*.blob.core.windows.net",
      ],
    });
  });
});
