import { describe, expect, it } from "vitest";
import {
  PROTECTED_PLUGIN_ROUTE_PREFIXES,
  canonicalizePathForSecurity,
  isPathProtectedByPrefixes,
  isProtectedPluginRoutePath,
} from "./security-path.js";

describe("security-path canonicalization", () => {
  it("canonicalizes decoded case/slash variants", () => {
    expect(canonicalizePathForSecurity("/API/channels//nostr/default/profile/")).toEqual({
      canonicalPath: "/api/channels/nostr/default/profile",
      candidates: ["/api/channels/nostr/default/profile"],
      malformedEncoding: false,
      rawNormalizedPath: "/api/channels/nostr/default/profile",
    });
    const encoded = canonicalizePathForSecurity("/api/%63hannels%2Fnostr%2Fdefault%2Fprofile");
    expect(encoded.canonicalPath).toBe("/api/channels/nostr/default/profile");
    expect(encoded.candidates).toContain("/api/%63hannels%2fnostr%2fdefault%2fprofile");
    expect(encoded.candidates).toContain("/api/channels/nostr/default/profile");
  });

  it("resolves traversal after repeated decoding", () => {
    expect(
      canonicalizePathForSecurity("/api/foo/..%2fchannels/nostr/default/profile").canonicalPath,
    ).toBe("/api/channels/nostr/default/profile");
    expect(
      canonicalizePathForSecurity("/api/foo/%252e%252e%252fchannels/nostr/default/profile")
        .canonicalPath,
    ).toBe("/api/channels/nostr/default/profile");
  });

  it("marks malformed encoding", () => {
    expect(canonicalizePathForSecurity("/api/channels%2").malformedEncoding).toBe(true);
    expect(canonicalizePathForSecurity("/api/channels%zz").malformedEncoding).toBe(true);
  });
});

describe("security-path protected-prefix matching", () => {
  const channelVariants = [
    "/API/channels/nostr/default/profile",
    "/api/channels%2Fnostr%2Fdefault%2Fprofile",
    "/api/%63hannels/nostr/default/profile",
    "/api/foo/..%2fchannels/nostr/default/profile",
    "/api/foo/%2e%2e%2fchannels/nostr/default/profile",
    "/api/foo/%252e%252e%252fchannels/nostr/default/profile",
    "/api/channels%2",
    "/api/channels%zz",
  ];

  for (const path of channelVariants) {
    it(`protects plugin channel path variant: ${path}`, () => {
      expect(isProtectedPluginRoutePath(path)).toBe(true);
      expect(isPathProtectedByPrefixes(path, PROTECTED_PLUGIN_ROUTE_PREFIXES)).toBe(true);
    });
  }

  it("does not protect unrelated paths", () => {
    expect(isProtectedPluginRoutePath("/plugin/public")).toBe(false);
    expect(isProtectedPluginRoutePath("/api/channels-public")).toBe(false);
    expect(isProtectedPluginRoutePath("/api/foo/..%2fchannels-public")).toBe(false);
    expect(isProtectedPluginRoutePath("/api/channel")).toBe(false);
  });
});
