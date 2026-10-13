// Android Version tests cover android version script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalAndroidVersionCode,
  normalizePinnedAndroidVersion,
  renderAndroidReleaseNotes,
  renderAndroidVersionProperties,
  resolveAndroidVersion,
  resolveGatewayVersionForAndroidRelease,
  syncAndroidVersioning,
} from "../../scripts/lib/android-version.ts";
import { extractChangelogSection } from "../../scripts/lib/mobile-changelog.ts";
import { normalizeGatewayVersionToPinnedMobileVersion } from "../../scripts/lib/mobile-version.ts";
import {
  parseVersionQueryArgs,
  parseVersionSyncArgs,
} from "../../scripts/lib/version-script-args.ts";
import {
  installAndroidFixtureCleanup,
  writeAndroidFixture,
} from "./android-version.test-support.ts";

installAndroidFixtureCleanup();

describe("resolveAndroidVersion", () => {
  it("preserves mobile parser ordering and platform-specific revision support", () => {
    expect(
      parseVersionQueryArgs(["--shell", "--", "--json", "--field", "canonicalVersion"]),
    ).toMatchObject({ field: "canonicalVersion", format: "json" });
    expect(parseVersionSyncArgs(["--check", "--write"])).toMatchObject({ mode: "write" });
    expect(() => parseVersionQueryArgs(["--field=canonicalVersion"])).toThrow(
      "Unknown argument: --field=canonicalVersion",
    );
    expect(() => parseVersionSyncArgs(["--revision"])).toThrow("Unknown argument: --revision");
    expect(
      parseVersionSyncArgs(["--revision", "1"], { allowAppStoreRevision: true }),
    ).toMatchObject({ appStoreRevision: "1" });
  });

  it("rejects missing CLI option values before reading version files", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-version.ts", "--field"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Missing value for --field.\n");

    const shortFlagResult = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-version.ts", "--field", "-h"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(shortFlagResult.status).toBe(1);
    expect(shortFlagResult.stderr).toBe("Missing value for --field.\n");
  });

  it("rejects missing Android sync CLI root values before reading version files", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-sync-versioning.ts", "--root", "--check"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Missing value for --root.\n");

    const shortFlagResult = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-sync-versioning.ts", "--root", "-h"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(shortFlagResult.status).toBe(1);
    expect(shortFlagResult.stderr).toBe("Missing value for --root.\n");
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
      "Expected 2026060201 through 2026060249 for version 2026.6.2",
    );
  });
});

describe("gateway version normalization", () => {
  it("strips prerelease suffixes when pinning from gateway version", () => {
    expect(normalizeGatewayVersionToPinnedMobileVersion("2026.6.2-beta.3")).toBe("2026.6.2");
    expect(normalizeGatewayVersionToPinnedMobileVersion("2026.6.2-alpha.1")).toBe("2026.6.2");
  });

  it("rejects pinned versions that cannot derive Play-compatible version codes", () => {
    expect(() => canonicalAndroidVersionCode("2026.6.100")).toThrow(
      "Unable to derive Android versionCode from 2026.6.100",
    );
  });

  it("rejects impossible gateway release versions", () => {
    expect(() => normalizeGatewayVersionToPinnedMobileVersion("2026.13.2-beta.1")).toThrow(
      "Expected YYYY.M.PATCH",
    );
    expect(() =>
      normalizeGatewayVersionToPinnedMobileVersion("2026.6.2-beta.9007199254740993"),
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
    const properties = renderAndroidVersionProperties({
      canonicalVersion: "2026.6.2",
      versionCode: 2026060201,
    });

    expect(properties).toContain("OPENCLAW_ANDROID_VERSION_NAME=2026.6.2");
    expect(properties).toContain("OPENCLAW_ANDROID_VERSION_CODE=2026060201");
  });
});

describe("renderAndroidReleaseNotes", () => {
  it("rejects changelogs without exact-version or Unreleased notes", () => {
    expect(() =>
      renderAndroidReleaseNotes(
        { canonicalVersion: "2026.6.2" },
        "# OpenClaw Android Changelog\n\n## 2026.6.1\n\nOld notes.\n",
      ),
    ).toThrow("Unable to find Android changelog notes for 2026.6.2");
  });

  it("treats empty changelog sections as absent", () => {
    expect(
      extractChangelogSection("## Unreleased\n\n\n## 2026.6.2\n\nNotes.\n", "Unreleased"),
    ).toBeNull();
  });
});

describe("syncAndroidVersioning", () => {
  it("checks only pinned metadata even when the Gateway has different release notes", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      packageVersion: "2026.9.2",
      changelog: "## 2026.6.2\n\nAPK notes.\n\n## 2026.9.2\n\nStore notes.\n",
      releaseNotes: "APK notes.\n",
    });
    syncAndroidVersioning({ rootDir });
    expect(syncAndroidVersioning({ mode: "check", rootDir }).updatedPaths).toEqual([]);
    fs.writeFileSync(resolveAndroidVersion(rootDir).releaseNotesPath, "Store notes.\n");
    expect(() => syncAndroidVersioning({ mode: "check", rootDir })).toThrow(
      "Android release notes is stale",
    );
  });
});
