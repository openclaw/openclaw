import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalAndroidVersionCode,
  normalizePinnedAndroidVersion as normalizePinned,
  renderAndroidReleaseNotes,
  resolveAndroidVersion,
  syncAndroidVersioning,
} from "../../scripts/lib/android-version.ts";
import { extractChangelogSection } from "../../scripts/lib/mobile-changelog.ts";
import { normalizeGatewayVersionToPinnedMobileVersion as pinGateway } from "../../scripts/lib/mobile-version.ts";
import {
  parseVersionQueryArgs,
  parseVersionSyncArgs,
} from "../../scripts/lib/version-script-args.ts";
import {
  installAndroidFixtureCleanup,
  writeAndroidFixture as writeFixture,
} from "./android-version.test-support.ts";

installAndroidFixtureCleanup();
const writeAndroidFixture = (overrides: Partial<Parameters<typeof writeFixture>[0]> = {}) =>
  writeFixture({ version: "2026.6.2", versionCode: 2026060201, ...overrides });

describe("Android versioning", () => {
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
    ).toMatchObject({
      appStoreRevision: "1",
    });
  });

  it.each([
    ["android-version", "--field"],
    ["android-sync-versioning", "--root"],
  ])("rejects missing %s %s values before reading version files", (script, flag) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", `scripts/${script}.ts`, flag, "-h"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    expect(result).toMatchObject({ status: 1, stderr: `Missing value for ${flag}.\n` });
  });

  it.each<[Partial<Parameters<typeof writeFixture>[0]>, string]>([
    [{ version: "1.2.3" }, "Expected pinned release version like 2026.6.5"],
    [{ versionCode: 2026060301 }, "Expected 2026060201 through 2026060249 for version 2026.6.2"],
  ])("rejects invalid pinned metadata %j", (overrides, message) => {
    expect(() => resolveAndroidVersion(writeAndroidFixture(overrides))).toThrow(message);
  });

  it.each([
    [normalizePinned, "2026.6.9007199254740993", "Expected pinned release version like 2026.6.5"],
    [pinGateway, "2026.13.2-beta.1", "Expected YYYY.M.PATCH"],
    [pinGateway, "2026.6.2-beta.9007199254740993", "Expected YYYY.M.PATCH"],
    [
      canonicalAndroidVersionCode,
      "2026.6.100",
      "Unable to derive Android versionCode from 2026.6.100",
    ],
  ] as const)("rejects an invalid version: %s %s", (parse, version, error) => {
    expect(() => parse(version)).toThrow(error);
  });

  it("rejects changelogs without exact-version or nonempty Unreleased notes", () => {
    const changelog = "## Unreleased\n\n## 2026.6.1\n\nOld notes.\n";
    expect(extractChangelogSection(changelog, "Unreleased")).toBeNull();
    expect(() => renderAndroidReleaseNotes({ canonicalVersion: "2026.6.2" }, changelog)).toThrow(
      "Unable to find Android changelog notes for 2026.6.2",
    );
  });

  it("checks only pinned metadata even when the Gateway has different release notes", () => {
    const rootDir = writeAndroidFixture({
      packageVersion: "2026.9.2",
      changelog: "## 2026.6.2\n\nAPK notes.\n\n## 2026.9.2\n\nStore notes.\n",
      releaseNotes: "APK notes.\n",
    });
    syncAndroidVersioning({ rootDir });
    const { versionPropertiesPath, releaseNotesPath } = resolveAndroidVersion(rootDir);
    const properties = fs.readFileSync(versionPropertiesPath, "utf8");
    expect(properties).toContain("OPENCLAW_ANDROID_VERSION_NAME=2026.6.2");
    expect(properties).toContain("OPENCLAW_ANDROID_VERSION_CODE=2026060201");
    expect(syncAndroidVersioning({ mode: "check", rootDir }).updatedPaths).toEqual([]);
    fs.writeFileSync(releaseNotesPath, "Store notes.\n");
    expect(() => syncAndroidVersioning({ mode: "check", rootDir })).toThrow(
      "Android release notes is stale",
    );
  });
});
