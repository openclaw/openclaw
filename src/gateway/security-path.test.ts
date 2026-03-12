import { describe, it, expect } from "vitest";
import {
  buildCanonicalPathCandidates,
  canonicalizePathVariant,
  canonicalizePathForSecurity,
  hasSecurityPathCanonicalizationAnomaly,
  isPathProtectedByPrefixes,
  isProtectedPluginRoutePath,
  PROTECTED_PLUGIN_ROUTE_PREFIXES,
} from "./security-path.js";

describe("buildCanonicalPathCandidates", () => {
  it("should return single candidate for simple path", () => {
    const result = buildCanonicalPathCandidates("/api/users");
    expect(result.candidates).toEqual(["/api/users"]);
    expect(result.decodePasses).toBe(0);
    expect(result.decodePassLimitReached).toBe(false);
    expect(result.malformedEncoding).toBe(false);
  });

  it("should decode URL-encoded path", () => {
    const result = buildCanonicalPathCandidates("/api%2Fusers");
    expect(result.candidates).toEqual(["/api%2fusers", "/api/users"]);
    expect(result.decodePasses).toBe(1);
  });

  it("should handle multiple decode passes", () => {
    const result = buildCanonicalPathCandidates("/api%252Fusers");
    expect(result.candidates).toEqual(["/api%252fusers", "/api%2fusers", "/api/users"]);
    expect(result.decodePasses).toBe(2);
  });

  it("should normalize path separators", () => {
    const result = buildCanonicalPathCandidates("/api//users");
    expect(result.candidates).toEqual(["/api/users"]);
  });

  it("should remove trailing slashes", () => {
    const result = buildCanonicalPathCandidates("/api/users/");
    expect(result.candidates).toEqual(["/api/users"]);
  });

  it("should handle root path", () => {
    const result = buildCanonicalPathCandidates("/");
    expect(result.candidates).toEqual(["/"]);
  });

  it("should handle empty path", () => {
    const result = buildCanonicalPathCandidates("");
    expect(result.candidates).toEqual(["/"]);
  });

  it("should lowercase path", () => {
    const result = buildCanonicalPathCandidates("/API/Users");
    expect(result.candidates).toEqual(["/api/users"]);
  });

  it("should handle malformed encoding", () => {
    const result = buildCanonicalPathCandidates("/api/%ZZ");
    expect(result.malformedEncoding).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("should respect max decode passes limit", () => {
    // Create a deeply encoded path
    let path = "/test";
    for (let i = 0; i < 40; i++) {
      path = encodeURIComponent(path);
    }
    const result = buildCanonicalPathCandidates(path, 32);
    expect(result.decodePasses).toBe(32);
    expect(result.decodePassLimitReached).toBe(true);
  });

  it("should deduplicate candidates", () => {
    const result = buildCanonicalPathCandidates("/api%2F%2Fusers");
    // Should not have duplicate normalized paths
    const uniqueCandidates = [...new Set(result.candidates)];
    expect(result.candidates).toEqual(uniqueCandidates);
  });
});

describe("canonicalizePathVariant", () => {
  it("should return canonical path for simple path", () => {
    expect(canonicalizePathVariant("/api/users")).toBe("/api/users");
  });

  it("should return decoded path", () => {
    expect(canonicalizePathVariant("/api%2Fusers")).toBe("/api/users");
  });

  it("should return root for empty path", () => {
    expect(canonicalizePathVariant("")).toBe("/");
  });

  it("should normalize separators", () => {
    expect(canonicalizePathVariant("/api//users")).toBe("/api/users");
  });

  it("should lowercase path", () => {
    expect(canonicalizePathVariant("/API/Users")).toBe("/api/users");
  });
});

describe("canonicalizePathForSecurity", () => {
  it("should return full canonicalization result", () => {
    const result = canonicalizePathForSecurity("/api%2Fusers");
    expect(result.canonicalPath).toBe("/api/users");
    expect(result.candidates).toContain("/api/users");
    expect(result.rawNormalizedPath).toBe("/api%2fusers");
    expect(result.decodePasses).toBe(1);
    expect(result.decodePassLimitReached).toBe(false);
    expect(result.malformedEncoding).toBe(false);
  });

  it("should include raw normalized path", () => {
    const result = canonicalizePathForSecurity("/API/Users");
    expect(result.rawNormalizedPath).toBe("/api/users");
  });
});

describe("hasSecurityPathCanonicalizationAnomaly", () => {
  it("should return false for normal path", () => {
    expect(hasSecurityPathCanonicalizationAnomaly("/api/users")).toBe(false);
  });

  it("should return true for malformed encoding", () => {
    expect(hasSecurityPathCanonicalizationAnomaly("/api/%ZZ")).toBe(true);
  });

  it("should return true when decode limit reached", () => {
    let path = "/test";
    for (let i = 0; i < 40; i++) {
      path = encodeURIComponent(path);
    }
    expect(hasSecurityPathCanonicalizationAnomaly(path)).toBe(true);
  });
});

describe("isPathProtectedByPrefixes", () => {
  it("should return true for exact match", () => {
    expect(isPathProtectedByPrefixes("/api/channels", ["/api/channels"])).toBe(true);
  });

  it("should return true for child path", () => {
    expect(isPathProtectedByPrefixes("/api/channels/123", ["/api/channels"])).toBe(true);
  });

  it("should return false for unrelated path", () => {
    expect(isPathProtectedByPrefixes("/api/users", ["/api/channels"])).toBe(false);
  });

  it("should handle multiple prefixes", () => {
    const prefixes = ["/api/channels", "/api/secrets"];
    expect(isPathProtectedByPrefixes("/api/channels/123", prefixes)).toBe(true);
    expect(isPathProtectedByPrefixes("/api/secrets/456", prefixes)).toBe(true);
    expect(isPathProtectedByPrefixes("/api/users", prefixes)).toBe(false);
  });

  it("should be case insensitive", () => {
    expect(isPathProtectedByPrefixes("/API/CHANNELS", ["/api/channels"])).toBe(true);
  });

  it("should handle encoded paths", () => {
    expect(isPathProtectedByPrefixes("/api%2Fchannels", ["/api/channels"])).toBe(true);
  });

  it("should fail closed for malformed encoding after prefix", () => {
    expect(isPathProtectedByPrefixes("/api/channels%ZZ", ["/api/channels"])).toBe(true);
  });

  it("should return true when decode limit reached", () => {
    let path = "/api/channels/test";
    for (let i = 0; i < 40; i++) {
      path = encodeURIComponent(path);
    }
    expect(isPathProtectedByPrefixes(path, ["/api/channels"])).toBe(true);
  });

  it("should normalize prefix", () => {
    expect(isPathProtectedByPrefixes("/api/channels", ["/API/Channels/"])).toBe(true);
  });
});

describe("isProtectedPluginRoutePath", () => {
  it("should return true for channels API path", () => {
    expect(isProtectedPluginRoutePath("/api/channels")).toBe(true);
    expect(isProtectedPluginRoutePath("/api/channels/123")).toBe(true);
  });

  it("should return false for other paths", () => {
    expect(isProtectedPluginRoutePath("/api/users")).toBe(false);
    expect(isProtectedPluginRoutePath("/health")).toBe(false);
  });

  it("should handle encoded paths", () => {
    expect(isProtectedPluginRoutePath("/api%2Fchannels")).toBe(true);
  });

  it("should be case insensitive", () => {
    expect(isProtectedPluginRoutePath("/API/CHANNELS")).toBe(true);
  });
});

describe("PROTECTED_PLUGIN_ROUTE_PREFIXES", () => {
  it("should include channels prefix", () => {
    expect(PROTECTED_PLUGIN_ROUTE_PREFIXES).toContain("/api/channels");
  });
});
