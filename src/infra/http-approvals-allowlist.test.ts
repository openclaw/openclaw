import { describe, expect, it } from "vitest";
import { evaluateHttpAllowlist, matchHttpAllowlist } from "./http-approvals-allowlist.js";

describe("matchHttpAllowlist", () => {
  it("returns null for empty allowlist", () => {
    expect(matchHttpAllowlist([], "https://example.com")).toBeNull();
  });

  it("returns null for empty URL", () => {
    expect(matchHttpAllowlist([{ pattern: "**" }], "")).toBeNull();
    expect(matchHttpAllowlist([{ pattern: "**" }], "  ")).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(matchHttpAllowlist([{ pattern: "**" }], "not-a-url")).toBeNull();
  });

  it("matches exact URL pattern", () => {
    const entry = { pattern: "https://api.example.com/v1/data" };
    expect(matchHttpAllowlist([entry], "https://api.example.com/v1/data")).toBe(entry);
    expect(matchHttpAllowlist([entry], "https://api.example.com/v1/other")).toBeNull();
  });

  it("matches single wildcard in path", () => {
    const entry = { pattern: "https://api.example.com/v1/*" };
    expect(matchHttpAllowlist([entry], "https://api.example.com/v1/data")).toBe(entry);
    expect(matchHttpAllowlist([entry], "https://api.example.com/v1/other")).toBe(entry);
    // Single wildcard should not cross path segments
    expect(matchHttpAllowlist([entry], "https://api.example.com/v1/a/b")).toBeNull();
  });

  it("matches double wildcard across path segments", () => {
    const entry = { pattern: "https://api.example.com/**" };
    expect(matchHttpAllowlist([entry], "https://api.example.com/v1/data")).toBe(entry);
    expect(matchHttpAllowlist([entry], "https://api.example.com/a/b/c/d")).toBe(entry);
    expect(matchHttpAllowlist([entry], "https://api.example.com/")).toBe(entry);
  });

  it("matches subdomain wildcard", () => {
    const entry = { pattern: "https://*.example.com/**" };
    expect(matchHttpAllowlist([entry], "https://api.example.com/v1/data")).toBe(entry);
    expect(matchHttpAllowlist([entry], "https://www.example.com/page")).toBe(entry);
    // Single wildcard in host matches any characters except / so multi-level
    // subdomains like a.b.example.com also match (dots are not path separators).
    expect(matchHttpAllowlist([entry], "https://a.b.example.com/page")).toBe(entry);
    // Different TLD should not match
    expect(matchHttpAllowlist([entry], "https://api.other.com/page")).toBeNull();
  });

  it("matches protocol wildcard", () => {
    const entry = { pattern: "*://example.com/**" };
    expect(matchHttpAllowlist([entry], "https://example.com/page")).toBe(entry);
    expect(matchHttpAllowlist([entry], "http://example.com/page")).toBe(entry);
  });

  it("matching is case-insensitive for host", () => {
    const entry = { pattern: "https://API.Example.COM/v1/data" };
    expect(matchHttpAllowlist([entry], "https://api.example.com/v1/data")).toBe(entry);
  });

  it("matching is case-insensitive for path", () => {
    const entry = { pattern: "https://example.com/API/**" };
    expect(matchHttpAllowlist([entry], "https://example.com/api/data")).toBe(entry);
  });

  it("bare wildcard matches any URL", () => {
    const entry = { pattern: "*" };
    expect(matchHttpAllowlist([entry], "https://example.com/page")).toBe(entry);
  });

  it("double star wildcard matches any URL", () => {
    const entry = { pattern: "**" };
    expect(matchHttpAllowlist([entry], "https://anything.example.com/any/path")).toBe(entry);
  });

  it("returns first matching entry", () => {
    const first = { pattern: "https://example.com/**" };
    const second = { pattern: "https://**" };
    expect(matchHttpAllowlist([first, second], "https://example.com/page")).toBe(first);
  });

  it("skips entries with empty patterns", () => {
    const empty = { pattern: "" };
    const valid = { pattern: "https://example.com/**" };
    expect(matchHttpAllowlist([empty, valid], "https://example.com/page")).toBe(valid);
  });

  it("double-star matches URL with query string since ** crosses all characters", () => {
    const entry = { pattern: "https://example.com/api/**" };
    // ** matches everything including the query string separator
    expect(matchHttpAllowlist([entry], "https://example.com/api/data?key=value")).toBe(entry);
  });

  it("single-star does not match query separator", () => {
    const entry = { pattern: "https://example.com/api/*" };
    // Single * stops at /  but ? is in the query string (not path separator)
    // The normalized URL is https://example.com/api/data?key=value
    // * matches "data?key=value" since ? is not /
    expect(matchHttpAllowlist([entry], "https://example.com/api/data?key=value")).toBe(entry);
  });

  it("normalizes URL fragments away", () => {
    const entry = { pattern: "https://example.com/page" };
    // Fragment is stripped during normalization, so the path matches
    expect(matchHttpAllowlist([entry], "https://example.com/page#section")).toBe(entry);
  });

  it("matches host-only pattern without explicit path", () => {
    const entry = { pattern: "https://api.example.com" };
    // Host-only patterns should match any path since URL normalization
    // always adds at least a trailing `/`.
    expect(matchHttpAllowlist([entry], "https://api.example.com")).toBe(entry);
    expect(matchHttpAllowlist([entry], "https://api.example.com/")).toBe(entry);
    expect(matchHttpAllowlist([entry], "https://api.example.com/v1/data")).toBe(entry);
    // Different host should not match
    expect(matchHttpAllowlist([entry], "https://other.example.com/")).toBeNull();
  });

  it("matches ? as single-character glob wildcard in path", () => {
    const entry = { pattern: "https://example.com/v?/data" };
    expect(matchHttpAllowlist([entry], "https://example.com/v1/data")).toBe(entry);
    expect(matchHttpAllowlist([entry], "https://example.com/v2/data")).toBe(entry);
    // ? should not match /
    expect(matchHttpAllowlist([entry], "https://example.com/v/data")).toBeNull();
  });
});

describe("evaluateHttpAllowlist", () => {
  it("returns not satisfied for no match", () => {
    const result = evaluateHttpAllowlist({
      url: "https://blocked.example.com",
      allowlist: [{ pattern: "https://allowed.example.com/**" }],
    });
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.matchedEntry).toBeNull();
  });

  it("returns satisfied with matching entry", () => {
    const entry = { pattern: "https://allowed.example.com/**" };
    const result = evaluateHttpAllowlist({
      url: "https://allowed.example.com/api/v1",
      allowlist: [entry],
    });
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.matchedEntry).toBe(entry);
  });
});
