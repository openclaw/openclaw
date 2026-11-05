// Verifies plugin package API compatibility ranges.
import { describe, expect, it } from "vitest";
import { satisfiesPluginApiRange } from "./package-compat.js";

describe("package plugin API compatibility", () => {
  it("preserves prerelease ordering for explicit plugin API prerelease floors", () => {
    expect(satisfiesPluginApiRange("2026.3.24-beta.1", ">=2026.3.24-beta.2")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24-beta.2", ">=2026.3.24-beta.2")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.24-1", ">=2026.3.24-beta.2")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.24", ">=2026.3.24-beta.2")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.24-beta.1", ">=2026.3.24")).toBe(true);
  });

  it("accepts legacy bare major.minor plugin api ranges as lower bounds", () => {
    expect(satisfiesPluginApiRange("2026.5.2", "2026.4")).toBe(true);
    expect(satisfiesPluginApiRange("2026.4.0", "2026.4")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.99", "2026.4")).toBe(false);
    expect(satisfiesPluginApiRange("2026.4.1", "=2026.4")).toBe(false);
    expect(satisfiesPluginApiRange("2026.5.2", "=2026.4")).toBe(false);
    expect(satisfiesPluginApiRange("invalid", "2026.4")).toBe(false);
  });

  it("rejects invalid runtime versions and impossible wildcard comparators", () => {
    expect(satisfiesPluginApiRange("invalid", "*")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24", ">*")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24", "<*")).toBe(false);
    expect(satisfiesPluginApiRange("1.5.0", ">=1.0.0 || >=2.0.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.2.3", "1.2.3||2.0.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.5.0", "1.0.0 - 2.0.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.2.3", "~>1.2.3")).toBe(false);
  });
});
