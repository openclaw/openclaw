import { describe, expect, it } from "vitest";
import { normalizeHostname } from "./hostname.js";

describe("normalizeHostname", () => {
  it.each([
    { input: " Example.COM. ", expected: "example.com" },
    { input: "   ", expected: "" },
    { input: " [FD7A:115C:A1E0::1] ", expected: "fd7a:115c:a1e0::1" },
    { input: " [FD7A:115C:A1E0::1]. ", expected: "fd7a:115c:a1e0::1" },
    { input: "[fd7a:115c:a1e0::1", expected: "[fd7a:115c:a1e0::1" },
    { input: "fd7a:115c:a1e0::1]", expected: "fd7a:115c:a1e0::1]" },
  ])("normalizes %j", ({ input, expected }) => {
    expect(normalizeHostname(input)).toBe(expected);
  });
});
