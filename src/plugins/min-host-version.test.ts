import { describe, expect, it } from "vitest";
import { checkMinHostVersion, parseMinHostVersionRequirement } from "./min-host-version.js";

const MIN_HOST_REQUIREMENT = {
  raw: ">=2026.3.22",
  minimumLabel: "2026.3.22",
};
describe("min-host-version", () => {
  it("accepts empty metadata", () => {
    expect(parseMinHostVersionRequirement(undefined)).toBeNull();
    expect(checkMinHostVersion({ currentVersion: "2026.3.22", minHostVersion: undefined })).toEqual(
      { ok: true, requirement: null },
    );
  });

  it("parses semver floors", () => {
    expect(parseMinHostVersionRequirement(">=2026.3.22")).toEqual(MIN_HOST_REQUIREMENT);
    for (const minimumLabel of ["2026.5.1-beta.1", "2026.5.1+20260501"]) {
      expect(parseMinHostVersionRequirement(`>=${minimumLabel}`)).toEqual({
        raw: `>=${minimumLabel}`,
        minimumLabel,
      });
    }
    expect(parseMinHostVersionRequirement(">=2026.5.1-beta..1")).toBeNull();
  });

  it("can parse legacy bare semver floors for runtime upgrade compatibility", () => {
    for (const raw of ["2026.3.22", "2026.7.2-beta.2+build.7"]) {
      expect(parseMinHostVersionRequirement(raw, { allowLegacyBareSemver: true })).toEqual({
        raw,
        minimumLabel: raw,
      });
    }
    expect(
      checkMinHostVersion({
        currentVersion: "2026.8.1",
        minHostVersion: "2026.7.2-beta.2",
        allowLegacyBareSemver: true,
      }),
    ).toEqual({
      ok: true,
      requirement: {
        raw: "2026.7.2-beta.2",
        minimumLabel: "2026.7.2-beta.2",
      },
    });
  });

  it.each([
    {
      name: "reports unknown host versions distinctly",
      currentVersion: "unknown",
      expected: {
        ok: false,
        kind: "unknown_host_version",
        requirement: MIN_HOST_REQUIREMENT,
      },
    },
    {
      name: "reports incompatible hosts",
      currentVersion: "2026.3.21",
      expected: {
        ok: false,
        kind: "incompatible",
        currentVersion: "2026.3.21",
        requirement: MIN_HOST_REQUIREMENT,
      },
    },
  ] as const)("$name", ({ currentVersion, expected }) => {
    expect(checkMinHostVersion({ currentVersion, minHostVersion: ">=2026.3.22" })).toEqual(
      expected,
    );
  });
});
