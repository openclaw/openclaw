import { describe, expect, it } from "vitest";
import {
  checkMinHostVersion,
  MIN_HOST_VERSION_FORMAT,
  parseMinHostVersionRequirement,
  validateMinHostVersion,
} from "./min-host-version.js";

const MIN_HOST_REQUIREMENT = {
  raw: ">=2026.3.22",
  minimumLabel: "2026.3.22",
};

function expectValidHostCheck(currentVersion: string, minHostVersion?: string) {
  expect(checkMinHostVersion({ currentVersion, minHostVersion })).toEqual({
    ok: true,
    requirement: minHostVersion ? MIN_HOST_REQUIREMENT : null,
  });
}

describe("min-host-version", () => {
  it("accepts empty metadata", () => {
    expect(validateMinHostVersion(undefined)).toBeNull();
    expect(parseMinHostVersionRequirement(undefined)).toBeNull();
    expectValidHostCheck("2026.3.22");
  });

  it("parses semver floors", () => {
    expect(parseMinHostVersionRequirement(">=2026.3.22")).toEqual(MIN_HOST_REQUIREMENT);
  });

  it.each(["2026.3.22", 123, ">=2026.3.22 garbage"] as const)(
    "rejects invalid floor syntax: %p",
    (minHostVersion) => {
      expect(validateMinHostVersion(minHostVersion)).toBe(MIN_HOST_VERSION_FORMAT);
    },
  );

  it.each(["2026.3.22", 123] as const)(
    "reports invalid floor syntax when checking host compatibility: %p",
    (minHostVersion) => {
      expect(checkMinHostVersion({ currentVersion: "2026.3.22", minHostVersion })).toEqual({
        ok: false,
        kind: "invalid",
        error: MIN_HOST_VERSION_FORMAT,
      });
    },
  );

  it("reports unknown host versions distinctly", () => {
    expect(
      checkMinHostVersion({ currentVersion: "unknown", minHostVersion: ">=2026.3.22" }),
    ).toEqual({
      ok: false,
      kind: "unknown_host_version",
      requirement: MIN_HOST_REQUIREMENT,
    });
  });

  it("reports incompatible hosts", () => {
    expect(
      checkMinHostVersion({ currentVersion: "2026.3.21", minHostVersion: ">=2026.3.22" }),
    ).toEqual({
      ok: false,
      kind: "incompatible",
      currentVersion: "2026.3.21",
      requirement: MIN_HOST_REQUIREMENT,
    });
  });

  it.each(["2026.3.22", "2026.4.0"] as const)(
    "accepts equal or newer hosts: %s",
    (currentVersion) => {
      expectValidHostCheck(currentVersion, ">=2026.3.22");
    },
  );
});
