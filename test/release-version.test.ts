import { describe, expect, it } from "vitest";
import releaseVersionCases from "../apps/linux/tests/release_version_cases.json" with { type: "json" };
import {
  classifyReleaseTrain,
  collectReleaseVersionFloorErrors,
  compareReleaseVersions,
  parsePinnedReleaseVersion,
  parseReleaseVersion,
} from "../scripts/lib/release-version.mjs";

describe("release version policy", () => {
  it.each([
    ["2026.7.2-alpha.1", "alpha"],
    ["2026.7.2-beta.1", "beta"],
    ["2026.7.32", "stable"],
    ["2026.6.33", "extended-stable"],
    ["2026.6.34", "extended-stable"],
    ["2026.6.33-1", "unsupported-extended-stable-correction"],
  ] as const)("classifies %s as %s", (version, expected) => {
    const parsed = parseReleaseVersion(version);
    if (!parsed) {
      throw new Error(`test version did not parse: ${version}`);
    }
    expect(classifyReleaseTrain(parsed)).toBe(expected);
  });

  it("blocks June 2026 stable and beta release trains below the published beta floor", () => {
    expect(collectReleaseVersionFloorErrors("2026.6.4")).toEqual([
      'June 2026 stable and beta release trains must use patch 5 or higher because 2026.6.5-beta.1 is already published; found "2026.6.4".',
    ]);
    expect(collectReleaseVersionFloorErrors("2026.6.4-beta.1")).toEqual([
      'June 2026 stable and beta release trains must use patch 5 or higher because 2026.6.5-beta.1 is already published; found "2026.6.4-beta.1".',
    ]);
  });

  it("keeps alpha compatibility and patch-floor release trains valid during the transition", () => {
    expect(collectReleaseVersionFloorErrors("2026.6.4-alpha.1")).toEqual([]);
    expect(collectReleaseVersionFloorErrors("2026.6.5-beta.2")).toEqual([]);
    expect(collectReleaseVersionFloorErrors("2026.7.1")).toEqual([]);
  });

  it.each(releaseVersionCases.ordered)(
    "orders shared desktop release $current -> $candidate",
    ({ current, candidate, ordering }) => {
      expect(compareReleaseVersions(candidate, current)).toBe(ordering);
    },
  );

  it.each(releaseVersionCases.unrecognized)("leaves %s outside calendar ordering", (version) => {
    expect(parseReleaseVersion(version)).toBeNull();
  });

  it.each([
    ["2026.1.1", "2026.1.1"],
    [" 2026.12.33 ", "2026.12.33"],
    ["9999.12.9007199254740991", "9999.12.9007199254740991"],
  ])("accepts stable release pin %j", (version, expected) => {
    expect(parsePinnedReleaseVersion(version)).toBe(expected);
  });

  it.each([
    "v2026.8.1",
    "V2026.8.1",
    "2026.8.1-alpha.1",
    "2026.8.1-beta.1",
    "2026.8.1-1",
    "2026.8.1+build.1",
    "latest",
    "^2026.8.1",
    "2026.8.x",
    "https://example.com/2026.8.1",
    "workspace:*",
    "file:../package",
    "git+https://example.com/repo.git",
    "2026. 8.1",
    "2026.08.1",
    "2026.8.01",
    "2026.13.1",
    "2026.8.9007199254740992",
  ])("rejects non-pin release form %j", (version) => {
    expect(parsePinnedReleaseVersion(version)).toBeNull();
  });
});
