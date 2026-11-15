import { describe, expect, it } from "vitest";
import { resolveReleaseQualificationScope } from "../../scripts/full-release-validation-policy.mjs";

describe("original qualification scope", () => {
  it.each([
    ["beta", "2026.11.5-beta.3", "release/2026.11.5", false, "npm-beta-v1", "npm-beta", "beta", ""],
    ["stable", "2026.11.5", "release/2026.11.5", true, "npm-stable-v1", "npm-stable", "beta", ""],
    ["full", "2026.11.5", "release/2026.11.5", true, undefined, "full", "beta", ""],
    [
      "stable",
      "2026.11.34",
      "extended-stable/2026.11.33",
      true,
      undefined,
      "full",
      "extended-stable",
      "extended-stable/2026.11.33",
    ],
    [
      "stable",
      "2026.11.5-1",
      "release/2026.11.5-1",
      true,
      "npm-stable-v1",
      "npm-stable",
      "beta",
      "",
    ],
    ["stable", "2026.11.5", "main", true, undefined, "full", "beta", ""],
  ] as const)(
    "preserves %s %s at %s",
    (
      releaseProfile,
      targetVersion,
      targetContextRef,
      runReleaseSoak,
      coveragePolicy,
      ciReleaseScope,
      npmDistTag,
      releaseCandidateBranch,
    ) => {
      expect(
        resolveReleaseQualificationScope({
          releaseProfile,
          targetVersion,
          targetContextRef,
          runReleaseSoak,
          rerunGroup: "all",
          crossOsSuiteFilter: "",
          skipPackageTelegramE2e: false,
        }),
      ).toEqual({
        coveragePolicy,
        ciReleaseScope,
        npmDistTag,
        releaseCandidateBranch,
        skipPackageTelegramE2e: releaseProfile === "beta" && !runReleaseSoak,
      });
    },
  );
  it("does not convert beta soak into reduced coverage", () => {
    expect(
      resolveReleaseQualificationScope({
        releaseProfile: "beta",
        targetVersion: "2026.11.5-beta.3",
        targetContextRef: "v2026.11.5-beta.3",
        runReleaseSoak: true,
        rerunGroup: "all",
        crossOsSuiteFilter: "",
        skipPackageTelegramE2e: true,
      }),
    ).toMatchObject({
      coveragePolicy: undefined,
      ciReleaseScope: "full",
      skipPackageTelegramE2e: true,
    });
  });
  it("rejects an extended-stable branch/version mismatch", () => {
    expect(() =>
      resolveReleaseQualificationScope({
        releaseProfile: "stable",
        targetVersion: "2026.12.34",
        targetContextRef: "extended-stable/2026.11.33",
        runReleaseSoak: true,
        rerunGroup: "all",
      }),
    ).toThrow("does not belong");
  });
});
