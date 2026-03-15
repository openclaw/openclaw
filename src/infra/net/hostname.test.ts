import { describe, expect, it } from "vitest";
import { normalizeHostname } from "./hostname.js";

describe("normalizeHostname", () => {
  it("trims, lowercases, and strips a trailing dot", () => {
    expect(normalizeHostname(" Example.COM. ")).toBe("example.com");
    expect(normalizeHostname("   ")).toBe("");
  });

  it("unwraps bracketed ipv6 hosts after normalization", () => {
    expect(normalizeHostname(" [FD7A:115C:A1E0::1] ")).toBe("fd7a:115c:a1e0::1");
    expect(normalizeHostname(" [FD7A:115C:A1E0::1]. ")).toBe("fd7a:115c:a1e0::1");
  });

  it("leaves non-fully-bracketed values otherwise unchanged", () => {
    expect(normalizeHostname("[fd7a:115c:a1e0::1")).toBe("[fd7a:115c:a1e0::1");
    expect(normalizeHostname("fd7a:115c:a1e0::1]")).toBe("fd7a:115c:a1e0::1]");
  });
});
