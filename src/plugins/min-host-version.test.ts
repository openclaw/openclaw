// Verifies plugin minimum host version compatibility checks.
import { describe, expect, it } from "vitest";
import {
  checkMinHostVersion,
  MIN_HOST_VERSION_FORMAT,
  parseMinHostVersionRequirement,
} from "./min-host-version.js";

const MIN_HOST_REQUIREMENT = {
  raw: ">=2026.3.22",
  minimumLabel: "2026.3.22",
};
const BETA_MIN_HOST_REQUIREMENT = {
  raw: ">=2026.5.1-beta.1",
  minimumLabel: "2026.5.1-beta.1",
};

function expectValidHostCheck(currentVersion: string, minHostVersion?: string) {
  expectHostCheckResult({
    currentVersion,
    minHostVersion,
    expected: {
      ok: true,
      requirement: minHostVersion ? MIN_HOST_REQUIREMENT : null,
    },
  });
}

function expectHostCheckResult(params: {
  currentVersion: string;
  minHostVersion?: string | number;
  expected: unknown;
}) {
  expect(
    checkMinHostVersion({
      currentVersion: params.currentVersion,
      minHostVersion: params.minHostVersion,
    }),
  ).toEqual(params.expected);
}

function expectInvalidHostCheck(minHostVersion: string | number) {
  expectHostCheckResult({
    currentVersion: "2026.3.22",
    minHostVersion,
    expected: {
      ok: false,
      kind: "invalid",
      error: MIN_HOST_VERSION_FORMAT,
    },
  });
}

describe("min-host-version", () => {
  it("accepts empty metadata", () => {
    expect(parseMinHostVersionRequirement(undefined)).toBeNull();
    expectValidHostCheck("2026.3.22");
  });

  it("parses semver floors", () => {
    expect(parseMinHostVersionRequirement(">=2026.3.22")).toEqual(MIN_HOST_REQUIREMENT);
    expect(parseMinHostVersionRequirement(">=2026.5.1-beta.1")).toEqual(BETA_MIN_HOST_REQUIREMENT);
    expect(parseMinHostVersionRequirement(">=2026.5.1+20260501")).toEqual({
      raw: ">=2026.5.1+20260501",
      minimumLabel: "2026.5.1+20260501",
    });
  });

  it("can parse legacy bare semver floors for runtime upgrade compatibility", () => {
    expect(parseMinHostVersionRequirement("2026.3.22", { allowLegacyBareSemver: true })).toEqual({
      raw: "2026.3.22",
      minimumLabel: "2026.3.22",
    });
    expect(
      checkMinHostVersion({
        currentVersion: "2026.3.22",
        minHostVersion: "2026.3.22",
        allowLegacyBareSemver: true,
      }),
    ).toEqual({
      ok: true,
      requirement: {
        raw: "2026.3.22",
        minimumLabel: "2026.3.22",
      },
    });
  });

  it.each(["2026.3.22", 123, ">=2026.3.22 garbage"] as const)(
    "rejects invalid floor syntax and host checks: %p",
    (minHostVersion) => {
      expectInvalidHostCheck(minHostVersion);
    },
  );

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
    expectHostCheckResult({
      currentVersion,
      minHostVersion: ">=2026.3.22",
      expected,
    });
  });

  it.each(["2026.3.22", "2026.4.0"] as const)(
    "accepts equal or newer hosts: %s",
    (currentVersion) => {
      expectValidHostCheck(currentVersion, ">=2026.3.22");
    },
  );
});

describe("checkMinHostVersion prerelease precedence", () => {
  it("rejects an older prerelease host against a newer prerelease floor", () => {
    expect(
      checkMinHostVersion({
        currentVersion: "2026.5.1-beta.1",
        minHostVersion: ">=2026.5.1-beta.3",
      }),
    ).toEqual({
      ok: false,
      kind: "incompatible",
      requirement: { raw: ">=2026.5.1-beta.3", minimumLabel: "2026.5.1-beta.3" },
      currentVersion: "2026.5.1-beta.1",
    });
  });

  it("rejects a prerelease host against the stable release floor", () => {
    expect(
      checkMinHostVersion({ currentVersion: "2026.5.1-beta.1", minHostVersion: ">=2026.5.1" }),
    ).toEqual({
      ok: false,
      kind: "incompatible",
      requirement: { raw: ">=2026.5.1", minimumLabel: "2026.5.1" },
      currentVersion: "2026.5.1-beta.1",
    });
  });

  it("accepts a newer prerelease host against an older prerelease floor", () => {
    expect(
      checkMinHostVersion({
        currentVersion: "2026.5.1-beta.3",
        minHostVersion: ">=2026.5.1-beta.1",
      }),
    ).toEqual({ ok: true, requirement: BETA_MIN_HOST_REQUIREMENT });
  });
});

describe("checkMinHostVersion stable correction releases", () => {
  it("accepts a stable correction host against its base stable floor", () => {
    // 2026.5.3-1 is a stable correction release that ships after 2026.5.3, so it must satisfy the
    // base floor; treating "-1" as a semver prerelease would wrongly reject the running host.
    expect(
      checkMinHostVersion({ currentVersion: "2026.5.3-1", minHostVersion: ">=2026.5.3" }),
    ).toEqual({ ok: true, requirement: { raw: ">=2026.5.3", minimumLabel: "2026.5.3" } });
  });

  it("accepts a stable correction host against the same correction floor", () => {
    expect(
      checkMinHostVersion({ currentVersion: "2026.5.3-1", minHostVersion: ">=2026.5.3-1" }),
    ).toEqual({ ok: true, requirement: { raw: ">=2026.5.3-1", minimumLabel: "2026.5.3-1" } });
  });

  it("rejects the base stable host against a later correction floor", () => {
    expect(
      checkMinHostVersion({ currentVersion: "2026.5.3", minHostVersion: ">=2026.5.3-1" }),
    ).toEqual({
      ok: false,
      kind: "incompatible",
      requirement: { raw: ">=2026.5.3-1", minimumLabel: "2026.5.3-1" },
      currentVersion: "2026.5.3",
    });
  });
});
