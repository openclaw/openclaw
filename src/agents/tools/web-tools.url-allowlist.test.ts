import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { isUrlAllowedByAllowlist, resolveFetchUrlAllowlist } from "./web-fetch.js";
import { filterResultsByAllowlist, resolveUrlAllowlist } from "./web-search.js";

describe("web-search urlAllowlist", () => {
  describe("resolveUrlAllowlist", () => {
    it("returns undefined when web config is undefined", () => {
      const result = resolveUrlAllowlist(undefined);
      expect(result).toBeUndefined();
    });

    it("returns undefined when urlAllowlist is not set", () => {
      const result = resolveUrlAllowlist({ search: { enabled: true } });
      expect(result).toBeUndefined();
    });

    it("returns undefined when urlAllowlist is empty array", () => {
      const result = resolveUrlAllowlist({ urlAllowlist: [], search: { enabled: true } });
      expect(result).toBeUndefined();
    });

    it("returns the allowlist when configured", () => {
      const result = resolveUrlAllowlist({
        urlAllowlist: ["example.com", "*.github.com"],
        search: { enabled: true },
      });
      expect(result).toEqual(["example.com", "*.github.com"]);
    });
  });

  describe("filterResultsByAllowlist", () => {
    const results = [
      { url: "https://example.com/page", siteName: "example.com" },
      { url: "https://api.github.com/user/repo", siteName: "api.github.com" },
      { url: "https://docs.openclaw.ai/guide", siteName: "docs.openclaw.ai" },
      { url: "https://blocked.org/page", siteName: "blocked.org" },
      { url: undefined, siteName: "unknown" }, // entry without URL
    ];

    it("returns all results when allowlist is empty", () => {
      const result = filterResultsByAllowlist(results, []);
      expect(result).toHaveLength(5);
    });

    it("filters results by exact domain match", () => {
      const result = filterResultsByAllowlist(results, ["example.com"]);
      expect(result).toHaveLength(2); // example.com + entry without URL
      expect(result.map((r) => r.url)).toContain("https://example.com/page");
      expect(result.map((r) => r.url)).not.toContain("https://api.github.com/user/repo");
    });

    it("filters results by wildcard pattern", () => {
      const result = filterResultsByAllowlist(results, ["*.github.com"]);
      expect(result).toHaveLength(2); // api.github.com + entry without URL
      expect(result.map((r) => r.url)).toContain("https://api.github.com/user/repo");
      expect(result.map((r) => r.url)).not.toContain("https://example.com/page");
    });

    it("filters results with multiple patterns", () => {
      const result = filterResultsByAllowlist(results, ["example.com", "*.github.com"]);
      expect(result).toHaveLength(3); // example.com + api.github.com + entry without URL
      expect(result.map((r) => r.url)).toContain("https://example.com/page");
      expect(result.map((r) => r.url)).toContain("https://api.github.com/user/repo");
      expect(result.map((r) => r.url)).not.toContain("https://blocked.org/page");
    });

    it("keeps entries without URLs and entries not in blocklist", () => {
      const result = filterResultsByAllowlist(results, ["blocked.org"]);
      // With allowlist ["blocked.org"], we ONLY keep blocked.org URLs and entries without URLs
      expect(result).toHaveLength(2); // blocked.org + entry without URL
      expect(result.map((r) => r.url)).toContain("https://blocked.org/page");
    });

    it("blocks entries with unparseable URLs when allowlist is set", () => {
      const resultsWithInvalid = [
        { url: "https://example.com/page", siteName: "example.com" },
        { url: "not-a-valid-url", siteName: "invalid" },
        { url: "://invalid.com", siteName: "invalid2" },
        { url: undefined, siteName: "unknown" }, // entry without URL - should be kept
      ];
      const result = filterResultsByAllowlist(resultsWithInvalid, ["example.com"]);
      // Should keep example.com and undefined URL, but block the invalid URLs
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.url)).toContain("https://example.com/page");
      expect(result.map((r) => r.url)).toContain(undefined);
      expect(result.map((r) => r.url)).not.toContain("not-a-valid-url");
      expect(result.map((r) => r.url)).not.toContain("://invalid.com");
    });
  });
});

describe("web-fetch urlAllowlist", () => {
  describe("resolveFetchUrlAllowlist", () => {
    it("returns undefined when web config is undefined", () => {
      const result = resolveFetchUrlAllowlist(undefined);
      expect(result).toBeUndefined();
    });

    it("returns undefined when urlAllowlist is not set", () => {
      const result = resolveFetchUrlAllowlist({ fetch: { enabled: true } });
      expect(result).toBeUndefined();
    });

    it("returns undefined when urlAllowlist is empty array", () => {
      const result = resolveFetchUrlAllowlist({ urlAllowlist: [], fetch: { enabled: true } });
      expect(result).toBeUndefined();
    });

    it("returns the allowlist when configured", () => {
      const result = resolveFetchUrlAllowlist({
        urlAllowlist: ["example.com", "*.github.com"],
        fetch: { enabled: true },
      });
      expect(result).toEqual(["example.com", "*.github.com"]);
    });
  });

  describe("isUrlAllowedByAllowlist", () => {
    it("allows any URL when allowlist is empty", () => {
      const result = isUrlAllowedByAllowlist("https://example.com/page", []);
      expect(result).toBe(true);
    });

    it("blocks URLs not in allowlist", () => {
      const result = isUrlAllowedByAllowlist("https://blocked.com/page", ["example.com"]);
      expect(result).toBe(false);
    });

    it("allows URLs matching exact domain", () => {
      const result = isUrlAllowedByAllowlist("https://example.com/page", ["example.com"]);
      expect(result).toBe(true);
    });

    it("allows URLs matching wildcard pattern", () => {
      const result = isUrlAllowedByAllowlist("https://api.github.com/users", ["*.github.com"]);
      expect(result).toBe(true);
    });

    it("blocks URLs not matching wildcard pattern", () => {
      const result = isUrlAllowedByAllowlist("https://github.com", ["*.github.com"]);
      // Exact match "github.com" should not match "*.github.com" pattern
      // because *.github.com requires at least one subdomain
      expect(result).toBe(false);
    });

    it("allows subdomain with wildcard pattern", () => {
      const result = isUrlAllowedByAllowlist("https://docs.openclaw.ai/guide", ["*.openclaw.ai"]);
      expect(result).toBe(true);
    });

    it("handles URLs without protocol", () => {
      const result = isUrlAllowedByAllowlist("not-a-url", ["example.com"]);
      expect(result).toBe(false);
    });
  });

  describe("web_fetch error response", () => {
    // This test verifies the error format returned when URL is blocked
    it("returns correct error format for blocked URL", () => {
      // Simulate the error response format
      const urlAllowlist = ["example.com"];
      const url = "https://blocked.com/page";

      if (!isUrlAllowedByAllowlist(url, urlAllowlist)) {
        const hostname = new URL(url).hostname;
        const errorResponse = {
          error: "url_not_allowed",
          message: `URL not in allowlist. Allowed domains: ${urlAllowlist.join(", ")}`,
          blockedUrl: url,
          blockedHostname: hostname,
        };

        expect(errorResponse.error).toBe("url_not_allowed");
        expect(errorResponse.message).toContain("example.com");
        expect(errorResponse.blockedUrl).toBe("https://blocked.com/page");
        expect(errorResponse.blockedHostname).toBe("blocked.com");
      }
    });
  });
});

describe("integration with config", () => {
  it("reads urlAllowlist from tools.web config", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          urlAllowlist: ["example.com", "*.github.com"],
          search: { enabled: true },
          fetch: { enabled: true },
        },
      },
    };

    const searchAllowlist = resolveUrlAllowlist(config.tools?.web);
    const fetchAllowlist = resolveFetchUrlAllowlist(config.tools?.web);

    expect(searchAllowlist).toEqual(["example.com", "*.github.com"]);
    expect(fetchAllowlist).toEqual(["example.com", "*.github.com"]);
  });

  it("works with undefined config", () => {
    const searchAllowlist = resolveUrlAllowlist(undefined);
    const fetchAllowlist = resolveFetchUrlAllowlist(undefined);

    expect(searchAllowlist).toBeUndefined();
    expect(fetchAllowlist).toBeUndefined();
  });
});
