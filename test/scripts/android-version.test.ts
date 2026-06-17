// Android Version tests cover android version script behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalAndroidVersionCode,
  normalizeGatewayVersionToPinnedAndroidVersion,
  normalizePinnedAndroidVersion,
  renderAndroidVersionProperties,
  resolveAndroidVersion,
  resolveGatewayVersionForAndroidRelease,
} from "../../scripts/lib/android-version.ts";
import {
  installAndroidFixtureCleanup,
  writeAndroidFixture,
} from "./android-version.test-support.ts";

installAndroidFixtureCleanup();

describe("resolveAndroidVersion", () => {
  it("parses pinned release versions and Android version codes", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
    });

    expect(resolveAndroidVersion(rootDir)).toEqual({
      canonicalVersion: "2026.6.2",
      versionCode: 2026060201,
      versionFilePath: path.join(rootDir, "apps/android/version.json"),
      versionPropertiesPath: path.join(rootDir, "apps/android/Config/Version.properties"),
    });
  });

  it("rejects semver-only versions", () => {
    const rootDir = writeAndroidFixture({
      version: "1.2.3",
      versionCode: 2026060201,
    });

    expect(() => resolveAndroidVersion(rootDir)).toThrow(
      "Expected pinned release version like 2026.6.5",
    );
  });

  it("rejects prerelease suffixes in the pinned Android version file", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2-beta.1",
      versionCode: 2026060201,
    });

    expect(() => resolveAndroidVersion(rootDir)).toThrow(
      "Expected pinned release version like 2026.6.5",
    );
  });

  it("rejects impossible pinned release versions", () => {
    expect(() => normalizePinnedAndroidVersion("2026.13.2")).toThrow(
      "Expected pinned release version like 2026.6.5",
    );
    expect(() => normalizePinnedAndroidVersion("2026.6.9007199254740993")).toThrow(
      "Expected pinned release version like 2026.6.5",
    );
  });

  it("rejects version codes that do not match the pinned version date", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060301,
    });

    expect(() => resolveAndroidVersion(rootDir)).toThrow(
      "Expected 2026060201 through 2026060299 for version 2026.6.2",
    );
  });
});

describe("gateway version normalization", () => {
  it("keeps stable gateway release values", () => {
    expect(normalizeGatewayVersionToPinnedAndroidVersion("2026.6.2")).toBe("2026.6.2");
  });

  it("strips prerelease suffixes when pinning from gateway version", () => {
    expect(normalizeGatewayVersionToPinnedAndroidVersion("2026.6.2-beta.3")).toBe("2026.6.2");
    expect(normalizeGatewayVersionToPinnedAndroidVersion("2026.6.2-alpha.1")).toBe("2026.6.2");
  });

  it("derives the default Play-compatible versionCode from the pinned version", () => {
    expect(canonicalAndroidVersionCode("2026.6.2")).toBe(2026060201);
  });

  it("rejects pinned versions that cannot derive Play-compatible version codes", () => {
    expect(() => canonicalAndroidVersionCode("2026.6.100")).toThrow(
      "Unable to derive Android versionCode from 2026.6.100",
    );
  });

  it("rejects impossible gateway release versions", () => {
    expect(() => normalizeGatewayVersionToPinnedAndroidVersion("2026.13.2-beta.1")).toThrow(
      "Expected YYYY.M.PATCH",
    );
    expect(() =>
      normalizeGatewayVersionToPinnedAndroidVersion("2026.6.2-beta.9007199254740993"),
    ).toThrow("Expected YYYY.M.PATCH");
  });

  it("reads and normalizes the root package version for Android releases", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      packageVersion: "2026.6.5-beta.3",
    });

    expect(resolveGatewayVersionForAndroidRelease(rootDir)).toEqual({
      packageVersion: "2026.6.5-beta.3",
      pinnedAndroidVersion: "2026.6.5",
      versionCode: 2026060501,
    });
  });
});

describe("renderAndroidVersionProperties", () => {
  it("renders checked-in defaults from the pinned Android version", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
    });
    const version = resolveAndroidVersion(rootDir);

    expect(renderAndroidVersionProperties(version)).toContain(
      "OPENCLAW_ANDROID_VERSION_NAME=2026.6.2",
    );
    expect(renderAndroidVersionProperties(version)).toContain(
      "OPENCLAW_ANDROID_VERSION_CODE=2026060201",
    );
  });
});
