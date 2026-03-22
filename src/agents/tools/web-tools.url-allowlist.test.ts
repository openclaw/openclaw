import { describe, expect, it } from "vitest";
import {
  AllowlistBlockedError,
  SsrFBlockedError,
  matchesHostnameAllowlist,
  normalizeHostnameAllowlist,
} from "../../infra/net/ssrf.js";
import { isUrlAllowedByAllowlist } from "./web-fetch.js";
import { __testing as webSearchTesting } from "./web-search.js";
import { resolveUrlAllowlist } from "./web-shared.js";

const { applyUrlAllowlistToPayload, filterResultsByAllowlist } = webSearchTesting;

// ---------------------------------------------------------------------------
// resolveUrlAllowlist
// ---------------------------------------------------------------------------
describe("resolveUrlAllowlist", () => {
  it("returns undefined when web config is undefined", () => {
    expect(resolveUrlAllowlist(undefined)).toBeUndefined();
  });

  it("returns undefined when urlAllowlist is not set", () => {
    expect(resolveUrlAllowlist({ search: {} })).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(resolveUrlAllowlist({ urlAllowlist: [] })).toBeUndefined();
  });

  it("returns normalized patterns for valid entries", () => {
    const result = resolveUrlAllowlist({ urlAllowlist: ["Example.COM", "*.GitHub.com"] });
    expect(result).toEqual(["example.com", "*.github.com"]);
  });

  it("deduplicates entries", () => {
    const result = resolveUrlAllowlist({
      urlAllowlist: ["example.com", "EXAMPLE.COM", "example.com"],
    });
    expect(result).toEqual(["example.com"]);
  });

  it("filters out bare * and *. patterns", () => {
    const result = resolveUrlAllowlist({ urlAllowlist: ["*", "*.", "example.com"] });
    expect(result).toEqual(["example.com"]);
  });
});

// ---------------------------------------------------------------------------
// normalizeHostnameAllowlist
// ---------------------------------------------------------------------------
describe("normalizeHostnameAllowlist", () => {
  it("returns empty array for undefined", () => {
    expect(normalizeHostnameAllowlist(undefined)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeHostnameAllowlist([])).toEqual([]);
  });

  it("lowercases and deduplicates", () => {
    const result = normalizeHostnameAllowlist(["FOO.COM", "foo.com", "Bar.org"]);
    expect(result).toEqual(["foo.com", "bar.org"]);
  });

  it("preserves wildcard prefixes", () => {
    const result = normalizeHostnameAllowlist(["*.Example.COM"]);
    expect(result).toEqual(["*.example.com"]);
  });
});

// ---------------------------------------------------------------------------
// matchesHostnameAllowlist
// ---------------------------------------------------------------------------
describe("matchesHostnameAllowlist", () => {
  it("allows any hostname when allowlist is empty", () => {
    expect(matchesHostnameAllowlist("anything.com", [])).toBe(true);
  });

  it("matches exact domain", () => {
    expect(matchesHostnameAllowlist("example.com", ["example.com"])).toBe(true);
  });

  it("rejects non-matching domain", () => {
    expect(matchesHostnameAllowlist("evil.com", ["example.com"])).toBe(false);
  });

  it("matches wildcard subdomain pattern", () => {
    expect(matchesHostnameAllowlist("sub.github.com", ["*.github.com"])).toBe(true);
  });

  it("matches deeply nested wildcard subdomain", () => {
    expect(matchesHostnameAllowlist("a.b.github.com", ["*.github.com"])).toBe(true);
  });

  it("wildcard does not match the bare domain itself", () => {
    expect(matchesHostnameAllowlist("github.com", ["*.github.com"])).toBe(false);
  });

  it("matches single-label hostname", () => {
    expect(matchesHostnameAllowlist("intranet", ["intranet"])).toBe(true);
  });

  it("rejects when no pattern matches", () => {
    expect(matchesHostnameAllowlist("evil.com", ["good.com", "*.trusted.org"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isUrlAllowedByAllowlist — smoke tests against the real export from web-fetch.ts
// ---------------------------------------------------------------------------

describe("isUrlAllowedByAllowlist", () => {
  it("allows any URL when allowlist is empty", () => {
    expect(isUrlAllowedByAllowlist("https://anything.com/path", [])).toBe(true);
  });

  it("allows URL matching exact domain", () => {
    expect(isUrlAllowedByAllowlist("https://example.com/page", ["example.com"])).toBe(true);
  });

  it("blocks URL not matching allowlist", () => {
    expect(isUrlAllowedByAllowlist("https://evil.com/page", ["example.com"])).toBe(false);
  });

  it("allows URL matching wildcard domain", () => {
    expect(isUrlAllowedByAllowlist("https://docs.github.com/en/rest", ["*.github.com"])).toBe(true);
  });

  it("returns false for invalid URL", () => {
    expect(isUrlAllowedByAllowlist("not-a-url", ["example.com"])).toBe(false);
  });

  it("handles URL with port", () => {
    expect(isUrlAllowedByAllowlist("https://example.com:8080/path", ["example.com"])).toBe(true);
  });

  it("handles http protocol", () => {
    expect(isUrlAllowedByAllowlist("http://example.com/path", ["example.com"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// filterResultsByAllowlist — smoke tests against the real export from web-search-core.ts
// ---------------------------------------------------------------------------

describe("filterResultsByAllowlist", () => {
  const results = [
    { url: "https://example.com/page1", title: "Example" },
    { url: "https://docs.github.com/rest", title: "GitHub Docs" },
    { url: "https://evil.com/hack", title: "Evil" },
    { url: "https://sub.example.com/nested", title: "Sub Example" },
  ];

  it("returns all results when allowlist is empty", () => {
    expect(filterResultsByAllowlist(results, [])).toEqual(results);
  });

  it("preserves url-less entries when allowlist is empty (no-op)", () => {
    const withMissing = [...results, { title: "No URL" } as { url?: string; title: string }];
    expect(filterResultsByAllowlist(withMissing, [])).toEqual(withMissing);
  });

  it("filters to only matching domains", () => {
    const filtered = filterResultsByAllowlist(results, ["example.com"]);
    expect(filtered).toEqual([{ url: "https://example.com/page1", title: "Example" }]);
  });

  it("supports wildcard patterns", () => {
    const filtered = filterResultsByAllowlist(results, ["*.github.com"]);
    expect(filtered).toEqual([{ url: "https://docs.github.com/rest", title: "GitHub Docs" }]);
  });

  it("supports multiple allowlist entries", () => {
    const filtered = filterResultsByAllowlist(results, ["example.com", "*.github.com"]);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.url)).toEqual([
      "https://example.com/page1",
      "https://docs.github.com/rest",
    ]);
  });

  it("wildcard matches subdomains", () => {
    const filtered = filterResultsByAllowlist(results, ["*.example.com"]);
    expect(filtered).toEqual([{ url: "https://sub.example.com/nested", title: "Sub Example" }]);
  });

  it("filters out entries with no url", () => {
    const withMissing = [...results, { title: "No URL" } as { url?: string; title: string }];
    const filtered = filterResultsByAllowlist(withMissing, ["example.com"]);
    expect(filtered.every((r) => r.url !== undefined)).toBe(true);
  });

  it("filters out entries with invalid URLs", () => {
    const withInvalid = [...results, { url: "not-valid", title: "Bad URL" }];
    const filtered = filterResultsByAllowlist(withInvalid, ["example.com"]);
    expect(filtered).toEqual([{ url: "https://example.com/page1", title: "Example" }]);
  });
});

// ---------------------------------------------------------------------------
// AllowlistBlockedError — verify it is exported, is an Error, and is
// distinguishable from SsrFBlockedError (both are re-thrown past the
// Firecrawl fallback in runWebFetch's catch block at web-fetch.ts:596).
// ---------------------------------------------------------------------------
describe("AllowlistBlockedError", () => {
  it("is an instance of Error", () => {
    const err = new AllowlistBlockedError("blocked");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AllowlistBlockedError");
    expect(err.message).toBe("blocked");
  });

  it("is distinguishable from SsrFBlockedError via instanceof", () => {
    const allowlistErr: Error = new AllowlistBlockedError("allowlist");
    const ssrfErr: Error = new SsrFBlockedError("ssrf");
    expect(allowlistErr).not.toBeInstanceOf(SsrFBlockedError);
    expect(ssrfErr).not.toBeInstanceOf(AllowlistBlockedError);
    // Both are re-thrown in the same catch guard in runWebFetch (web-fetch.ts:596):
    //   if (error instanceof SsrFBlockedError || error instanceof AllowlistBlockedError) throw error;
    // This ensures neither error falls through to the Firecrawl fallback path.
    expect(
      allowlistErr instanceof SsrFBlockedError || allowlistErr instanceof AllowlistBlockedError,
    ).toBe(true);
    expect(ssrfErr instanceof SsrFBlockedError || ssrfErr instanceof AllowlistBlockedError).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// applyUrlAllowlistToPayload — citations (LLM providers: Perplexity/Grok/Kimi/Gemini)
// Blocked citations are replaced with a placeholder to preserve index alignment.
// ---------------------------------------------------------------------------
describe("applyUrlAllowlistToPayload (citations)", () => {
  it("replaces blocked string citations with a placeholder to preserve index alignment", () => {
    const payload = {
      content: "See [1] and [3] for details.",
      citations: [
        "https://example.com/page",
        "https://evil.com/page",
        "https://docs.github.com/en/rest",
      ],
    };
    const result = applyUrlAllowlistToPayload(payload as Record<string, unknown>, [
      "example.com",
      "*.github.com",
    ]);
    expect(result.citations).toEqual([
      "https://example.com/page",
      "[blocked by urlAllowlist]",
      "https://docs.github.com/en/rest",
    ]);
  });

  it("passes through citations unchanged when no allowlist", () => {
    const payload = { citations: ["https://example.com", "https://evil.com"] };
    const result = applyUrlAllowlistToPayload(payload as Record<string, unknown>, undefined);
    expect(result.citations).toEqual(["https://example.com", "https://evil.com"]);
  });

  it("replaces blocked inlineCitation urls with a placeholder to preserve index alignment", () => {
    const payload = {
      content: "See [1].",
      inlineCitations: [
        { url: "https://example.com/page", title: "Example" },
        { url: "https://evil.com/page", title: "Evil" },
        { url: "https://docs.github.com/", title: "GitHub" },
      ],
    };
    const result = applyUrlAllowlistToPayload(payload as Record<string, unknown>, [
      "example.com",
      "*.github.com",
    ]);
    expect(result.inlineCitations).toEqual([
      { url: "https://example.com/page", title: "Example" },
      { url: "[blocked by urlAllowlist]", title: "Evil" },
      { url: "https://docs.github.com/", title: "GitHub" },
    ]);
  });

  it("filters results array and replaces blocked citations in the same payload", () => {
    const payload = {
      results: [
        { url: "https://example.com/page", title: "Example" },
        { url: "https://evil.com/hack", title: "Evil" },
      ],
      citations: ["https://example.com/page", "https://evil.com/hack"],
    };
    const result = applyUrlAllowlistToPayload(payload as Record<string, unknown>, ["example.com"]);
    expect((result.results as Array<{ url: string }>).map((r) => r.url)).toEqual([
      "https://example.com/page",
    ]);
    expect(result.citations).toEqual(["https://example.com/page", "[blocked by urlAllowlist]"]);
  });
});
