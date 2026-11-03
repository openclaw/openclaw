import { describe, expect, it } from "vitest";
import { isLocalPortalHostname, isLoopbackHostname } from "./gateway-locality.ts";

describe("isLoopbackHostname", () => {
  // Credential retry trust stays strict: a `.localhost` name is a different origin and must
  // never receive the stored device token.
  it.each([
    ["localhost", true],
    ["openclaw.localhost", false],
    ["127.0.0.5", true],
    ["[::1]", true],
    ["127.0.0.1.evil.com", false],
    ["localhost.evil.com", false],
  ])("classifies %s as a trusted loopback endpoint: %s", (hostname, expected) => {
    expect(isLoopbackHostname(hostname)).toBe(expected);
  });
});

describe("isLocalPortalHostname", () => {
  it.each([
    ["localhost", true],
    ["openclaw.localhost", true],
    ["a.b.localhost", true],
    ["OPENCLAW.LOCALHOST", true],
    ["  openclaw.localhost  ", true],
    ["127.0.0.5", true],
    ["[::1]", true],
    ["127.0.0.1.evil.com", false],
    ["localhost.evil.com", false],
    ["evil-localhost", false],
    ["example.com", false],
  ])("classifies %s as a local portal origin: %s", (hostname, expected) => {
    expect(isLocalPortalHostname(hostname)).toBe(expected);
  });
});
