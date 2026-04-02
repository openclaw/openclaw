import { describe, expect, it } from "vitest";
import {
  checkVersionSkew,
  compareOpenClawVersions,
  isSameOpenClawStableFamily,
  parseOpenClawVersion,
  shouldWarnOnTouchedVersion,
} from "./version.js";

describe("parseOpenClawVersion", () => {
  it("parses stable, correction, and beta forms", () => {
    expect(parseOpenClawVersion("2026.3.23")).toEqual({
      major: 2026,
      minor: 3,
      patch: 23,
      revision: null,
      prerelease: null,
    });
    expect(parseOpenClawVersion("2026.3.23-1")).toEqual({
      major: 2026,
      minor: 3,
      patch: 23,
      revision: 1,
      prerelease: null,
    });
    expect(parseOpenClawVersion("2026.3.23-beta.1")).toEqual({
      major: 2026,
      minor: 3,
      patch: 23,
      revision: null,
      prerelease: ["beta", "1"],
    });
    expect(parseOpenClawVersion("v2026.3.23.beta.2")).toEqual({
      major: 2026,
      minor: 3,
      patch: 23,
      revision: null,
      prerelease: ["beta", "2"],
    });
  });

  it("rejects invalid versions", () => {
    expect(parseOpenClawVersion("2026.3")).toBeNull();
    expect(parseOpenClawVersion("latest")).toBeNull();
  });
});

describe("compareOpenClawVersions", () => {
  it("treats correction publishes as newer than the base stable release", () => {
    expect(compareOpenClawVersions("2026.3.23", "2026.3.23-1")).toBe(-1);
    expect(compareOpenClawVersions("2026.3.23-1", "2026.3.23")).toBe(1);
    expect(compareOpenClawVersions("2026.3.23-2", "2026.3.23-1")).toBe(1);
  });

  it("treats stable as newer than beta and compares beta identifiers", () => {
    expect(compareOpenClawVersions("2026.3.23", "2026.3.23-beta.1")).toBe(1);
    expect(compareOpenClawVersions("2026.3.23-beta.2", "2026.3.23-beta.1")).toBe(1);
    expect(compareOpenClawVersions("2026.3.23.beta.1", "2026.3.23-beta.2")).toBe(-1);
  });
});

describe("isSameOpenClawStableFamily", () => {
  it("treats same-base stable and correction versions as one family", () => {
    expect(isSameOpenClawStableFamily("2026.3.23", "2026.3.23-1")).toBe(true);
    expect(isSameOpenClawStableFamily("2026.3.23-1", "2026.3.23-2")).toBe(true);
    expect(isSameOpenClawStableFamily("2026.3.23", "2026.3.24")).toBe(false);
    expect(isSameOpenClawStableFamily("2026.3.23-beta.1", "2026.3.23")).toBe(false);
  });
});

describe("shouldWarnOnTouchedVersion", () => {
  it("skips same-base stable families", () => {
    expect(shouldWarnOnTouchedVersion("2026.3.23", "2026.3.23-1")).toBe(false);
    expect(shouldWarnOnTouchedVersion("2026.3.23-1", "2026.3.23-2")).toBe(false);
  });

  it("skips same-base correction publishes even when current is a prerelease", () => {
    expect(shouldWarnOnTouchedVersion("2026.3.23-beta.1", "2026.3.23-1")).toBe(false);
  });

  it("skips same-base prerelease configs when current is newer", () => {
    expect(shouldWarnOnTouchedVersion("2026.3.23", "2026.3.23-beta.1")).toBe(false);
  });

  it("warns when the touched config is newer", () => {
    expect(shouldWarnOnTouchedVersion("2026.3.23-beta.1", "2026.3.23")).toBe(true);
    expect(shouldWarnOnTouchedVersion("2026.3.23", "2026.3.24")).toBe(true);
    expect(shouldWarnOnTouchedVersion("2026.3.23", "2027.1.1")).toBe(true);
  });
});

describe("checkVersionSkew", () => {
  it("returns not skewed when touched version is null", () => {
    const result = checkVersionSkew("2026.3.23", null);
    expect(result.skewed).toBe(false);
    expect(result.message).toBeNull();
    expect(result.guidance).toBeNull();
    expect(result.configVersion).toBeNull();
    expect(result.currentVersion).toBe("2026.3.23");
  });

  it("returns not skewed when touched version is undefined", () => {
    const result = checkVersionSkew("2026.3.23", undefined);
    expect(result.skewed).toBe(false);
    expect(result.configVersion).toBeNull();
  });

  it("returns not skewed for same-family versions", () => {
    const result = checkVersionSkew("2026.3.23", "2026.3.23-1");
    expect(result.skewed).toBe(false);
    expect(result.message).toBeNull();
    expect(result.guidance).toBeNull();
    expect(result.configVersion).toBe("2026.3.23-1");
  });

  it("returns not skewed when current is newer", () => {
    const result = checkVersionSkew("2026.3.24", "2026.3.23");
    expect(result.skewed).toBe(false);
    expect(result.configVersion).toBe("2026.3.23");
  });

  it("returns skewed with message and guidance when config is from a newer version", () => {
    const result = checkVersionSkew("2026.3.23", "2026.3.24");
    expect(result.skewed).toBe(true);
    expect(result.message).toBe(
      "Config was last written by a newer OpenClaw (2026.3.24); current version is 2026.3.23.",
    );
    expect(result.guidance).toBe(
      "Run `openclaw update` to update, or `openclaw doctor` to check compatibility.",
    );
    expect(result.configVersion).toBe("2026.3.24");
    expect(result.currentVersion).toBe("2026.3.23");
  });

  it("returns skewed when major version differs", () => {
    const result = checkVersionSkew("2026.3.23", "2027.1.1");
    expect(result.skewed).toBe(true);
    expect(result.message).toContain("2027.1.1");
    expect(result.guidance).toContain("openclaw update");
    expect(result.guidance).toContain("openclaw doctor");
  });

  it("returns skewed when beta is older than stable", () => {
    const result = checkVersionSkew("2026.3.23-beta.1", "2026.3.23");
    expect(result.skewed).toBe(true);
    expect(result.message).toContain("2026.3.23");
    expect(result.guidance).not.toBeNull();
  });
});
