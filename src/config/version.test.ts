// Verifies config version handling and future-version guards.
import { describe, expect, it } from "vitest";
import { compareOpenClawVersions, shouldWarnOnTouchedVersion } from "./version.js";

describe("compareOpenClawVersions", () => {
  it("treats stable as newer than beta and compares beta identifiers", () => {
    expect(compareOpenClawVersions("2026.6.5", "2026.6.6-beta.1")).toBe(-1);
    expect(compareOpenClawVersions("2026.3.23", "2026.3.23-beta.1")).toBe(1);
    expect(compareOpenClawVersions("2026.3.23-beta.2", "2026.3.23-beta.1")).toBe(1);
    expect(compareOpenClawVersions("2026.3.23.beta.1", "2026.3.23-beta.2")).toBe(-1);
  });
});

describe("shouldWarnOnTouchedVersion", () => {
  it("skips same-base correction publishes even when current is a prerelease", () => {
    expect(shouldWarnOnTouchedVersion("2026.3.23-beta.1", "2026.3.23-1")).toBe(false);
  });

  it("still warns when the touched prerelease is newer", () => {
    expect(shouldWarnOnTouchedVersion("2026.5.2-beta.2", "2026.5.2-beta.3")).toBe(true);
  });
});
