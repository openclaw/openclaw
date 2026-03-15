import { describe, expect, it } from "vitest";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  normalizeHostnameSuffixAllowlist,
} from "./ssrf-policy.js";

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
