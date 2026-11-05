// Hostname normalization tests cover DNS trailing dots, empty input, and
// bracketed IPv6 literal handling.
import { describe, expect, it } from "vitest";
import { normalizeHostname } from "./hostname.js";

describe("normalizeHostname", () => {
  it.each([
    { input: " Example.COM... ", expected: "example.com" },
    { input: "   ", expected: "" },
    { input: " [FD7A:115C:A1E0::1]... ", expected: "fd7a:115c:a1e0::1" },
    { input: "[fd7a:115c:a1e0::1", expected: "[fd7a:115c:a1e0::1" },
    { input: "fd7a:115c:a1e0::1]", expected: "fd7a:115c:a1e0::1]" },
    { input: "München.de", expected: "xn--mnchen-3ya.de" },
    { input: "xn--mnchen-3ya.de", expected: "xn--mnchen-3ya.de" },
    { input: "*.München.de", expected: "*.xn--mnchen-3ya.de" },
  ])("normalizes %j", ({ input, expected }) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it("does not treat a lookalike label as the allowlisted name", () => {
    const lookalike = "ex\u0430mple.com";
    expect(normalizeHostname(lookalike)).not.toBe("example.com");
    expect(normalizeHostname("example.com")).toBe("example.com");
  });
});
