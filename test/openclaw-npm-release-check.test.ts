import { describe, expect, it } from "vitest";
import {
  collectReleasePackageMetadataErrors,
  collectReleaseTagErrors,
  parseReleaseVersion,
  utcCalendarDayDistance,
} from "../scripts/openclaw-npm-release-check.ts";

describe("parseReleaseVersion", () => {
  it("parses stable CalVer releases", () => {
    expect(parseReleaseVersion("2026.3.9")).toMatchObject({
      version: "2026.3.9",
      channel: "stable",
      year: 2026,
      month: 3,
      day: 9,
    });
  });

  it("parses beta CalVer releases", () => {
    expect(parseReleaseVersion("2026.3.9-beta.2")).toMatchObject({
      version: "2026.3.9-beta.2",
      channel: "beta",
      year: 2026,
      month: 3,
      day: 9,
      betaNumber: 2,
    });
  });

  it("rejects legacy and malformed release formats", () => {
    expect(parseReleaseVersion("2026.3.9-1")).toBeNull();
    expect(parseReleaseVersion("2026.03.09")).toBeNull();
    expect(parseReleaseVersion("v2026.3.9")).toBeNull();
    expect(parseReleaseVersion("2026.2.30")).toBeNull();
    expect(parseReleaseVersion("2.0.0-beta2")).toBeNull();
  });
});

describe("utcCalendarDayDistance", () => {
  it("compares UTC calendar days rather than wall-clock hours", () => {
    const left = new Date("2026-03-09T23:59:59Z");
    const right = new Date("2026-03-11T00:00:01Z");
    expect(utcCalendarDayDistance(left, right)).toBe(2);
  });
});

describe("collectReleaseTagErrors", () => {
  it("accepts versions within the two-day CalVer window", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.9",
        releaseTag: "v2026.3.9",
        now: new Date("2026-03-11T12:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("rejects versions outside the two-day CalVer window", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.9",
        releaseTag: "v2026.3.9",
        now: new Date("2026-03-12T00:00:00Z"),
      }),
    ).toContainEqual(expect.stringContaining("must be within 2 days"));
  });

  it("rejects tags that do not match the current release format", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.9",
        releaseTag: "v2026.3.9-1",
        now: new Date("2026-03-09T00:00:00Z"),
      }),
    ).toContainEqual(expect.stringContaining("must match vYYYY.M.D or vYYYY.M.D-beta.N"));
  });
});

describe("collectReleasePackageMetadataErrors", () => {
  it("validates the expected npm package metadata", () => {
    expect(
      collectReleasePackageMetadataErrors({
        name: "openclaw",
        description: "Multi-channel AI gateway with extensible messaging integrations",
        license: "MIT",
        repository: { url: "git+https://github.com/openclaw/openclaw.git" },
        bin: { openclaw: "openclaw.mjs" },
      }),
    ).toEqual([]);
  });
});
