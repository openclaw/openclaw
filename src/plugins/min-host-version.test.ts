import { describe, expect, it } from "vitest";
import {
  checkMinHostVersion,
  MIN_HOST_VERSION_FORMAT,
  parseMinHostVersionRequirement,
  validateMinHostVersion,
} from "./min-host-version.js";

describe("min-host-version", () => {
  it("accepts empty metadata", () => {
    expect(validateMinHostVersion(undefined)).toBeNull();
    expect(parseMinHostVersionRequirement(undefined)).toBeNull();
    expect(checkMinHostVersion({ currentVersion: "2026.3.14", minHostVersion: undefined })).toEqual(
      {
        ok: true,
        requirement: null,
      },
    );
  });

  it("parses semver floors", () => {
    expect(parseMinHostVersionRequirement(">=2026.3.14")).toEqual({
      raw: ">=2026.3.14",
      minimumLabel: "2026.3.14",
    });
  });

  it("rejects invalid floor syntax", () => {
    expect(validateMinHostVersion("2026.3.14")).toBe(MIN_HOST_VERSION_FORMAT);
    expect(validateMinHostVersion(">=2026.3.14 garbage")).toBe(MIN_HOST_VERSION_FORMAT);
    expect(
      checkMinHostVersion({ currentVersion: "2026.3.14", minHostVersion: "2026.3.14" }),
    ).toEqual({
      ok: false,
      kind: "invalid",
      error: MIN_HOST_VERSION_FORMAT,
    });
  });

  it("reports unknown host versions distinctly", () => {
    expect(
      checkMinHostVersion({ currentVersion: "unknown", minHostVersion: ">=2026.3.14" }),
    ).toEqual({
      ok: false,
      kind: "unknown_host_version",
      requirement: {
        raw: ">=2026.3.14",
        minimumLabel: "2026.3.14",
      },
    });
  });

  it("reports incompatible hosts", () => {
    expect(
      checkMinHostVersion({ currentVersion: "2026.3.13", minHostVersion: ">=2026.3.14" }),
    ).toEqual({
      ok: false,
      kind: "incompatible",
      currentVersion: "2026.3.13",
      requirement: {
        raw: ">=2026.3.14",
        minimumLabel: "2026.3.14",
      },
    });
  });

  it("accepts equal or newer hosts", () => {
    expect(
      checkMinHostVersion({ currentVersion: "2026.3.14", minHostVersion: ">=2026.3.14" }),
    ).toEqual({
      ok: true,
      requirement: {
        raw: ">=2026.3.14",
        minimumLabel: "2026.3.14",
      },
    });
    expect(
      checkMinHostVersion({ currentVersion: "2026.4.0", minHostVersion: ">=2026.3.14" }),
    ).toEqual({
      ok: true,
      requirement: {
        raw: ">=2026.3.14",
        minimumLabel: "2026.3.14",
      },
    });
  });
});
