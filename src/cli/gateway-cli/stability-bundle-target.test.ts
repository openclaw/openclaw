import { describe, expect, it } from "vitest";
import { normalizeStabilityBundleTarget } from "./stability-bundle-target.js";

describe("normalizeStabilityBundleTarget", () => {
  it("treats omitted and false values as disabled", () => {
    expect(normalizeStabilityBundleTarget(undefined)).toBeNull();
    expect(normalizeStabilityBundleTarget(false)).toBeNull();
  });

  it("maps bare --bundle to latest", () => {
    expect(normalizeStabilityBundleTarget(true)).toBe("latest");
  });

  it("keeps explicit paths and latest", () => {
    expect(normalizeStabilityBundleTarget("latest")).toBe("latest");
    expect(normalizeStabilityBundleTarget("/tmp/bundle.json")).toBe("/tmp/bundle.json");
  });

  it("rejects blank and whitespace-only --bundle values", () => {
    expect(() => normalizeStabilityBundleTarget("")).toThrow(
      '--bundle must be a non-empty path or "latest".',
    );
    expect(() => normalizeStabilityBundleTarget("   ")).toThrow(
      '--bundle must be a non-empty path or "latest".',
    );
  });
});
