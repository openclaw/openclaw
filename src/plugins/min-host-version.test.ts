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
    expect(checkMinHostVersion({ currentVersion: "2026.3.22", minHostVersion: undefined })).toEqual(
      {
        ok: true,
        requirement: null,
      },
    );
  });

  it("parses semver floors", () => {
    expect(parseMinHostVersionRequirement(">=2026.3.22")).toEqual({
      raw: ">=2026.3.22",
      minimumLabel: "2026.3.22",
    });
  });

  it("rejects invalid floor syntax", () => {
    expect(validateMinHostVersion("2026.3.22")).toBe(MIN_HOST_VERSION_FORMAT);
    expect(validateMinHostVersion(123)).toBe(MIN_HOST_VERSION_FORMAT);
    expect(validateMinHostVersion(">=2026.3.22 garbage")).toBe(MIN_HOST_VERSION_FORMAT);
    expect(
      checkMinHostVersion({ currentVersion: "2026.3.22", minHostVersion: "2026.3.22" }),
    ).toEqual({
      ok: false,
      kind: "invalid",
      error: MIN_HOST_VERSION_FORMAT,
    });
  });

  it("treats non-string host floor metadata as invalid instead of throwing", () => {
    expect(checkMinHostVersion({ currentVersion: "2026.3.22", minHostVersion: 123 })).toEqual({
      ok: false,
      kind: "invalid",
      error: MIN_HOST_VERSION_FORMAT,
    });
  });

  it("reports unknown host versions distinctly", () => {
    expect(
      checkMinHostVersion({ currentVersion: "unknown", minHostVersion: ">=2026.3.22" }),
    ).toEqual({
      ok: false,
      kind: "unknown_host_version",
      requirement: {
        raw: ">=2026.3.22",
        minimumLabel: "2026.3.22",
      },
    });
  });

  it("reports incompatible hosts", () => {
    expect(
      checkMinHostVersion({ currentVersion: "2026.3.21", minHostVersion: ">=2026.3.22" }),
    ).toEqual({
      ok: false,
      kind: "incompatible",
      currentVersion: "2026.3.21",
      requirement: {
        raw: ">=2026.3.22",
        minimumLabel: "2026.3.22",
      },
    });
  });

  it("accepts equal or newer hosts", () => {
    expect(
      checkMinHostVersion({ currentVersion: "2026.3.22", minHostVersion: ">=2026.3.22" }),
    ).toEqual({
      ok: true,
      requirement: {
        raw: ">=2026.3.22",
        minimumLabel: "2026.3.22",
      },
    });
    expect(
      checkMinHostVersion({ currentVersion: "2026.4.0", minHostVersion: ">=2026.3.22" }),
    ).toEqual({
      ok: true,
      requirement: {
        raw: ">=2026.3.22",
        minimumLabel: "2026.3.22",
      },
    });
  });
});
