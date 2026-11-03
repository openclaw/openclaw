import { describe, expect, it } from "vitest";
import { isLoopbackHostname } from "./gateway-locality.ts";

describe("isLoopbackHostname", () => {
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
  ])("classifies %s as loopback: %s", (hostname, expected) => {
    expect(isLoopbackHostname(hostname)).toBe(expected);
  });
});
