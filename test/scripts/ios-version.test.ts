import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeIosAppStoreVersion,
  normalizeIosAppStoreRevision,
  renderIosReleaseNotes,
  resolveGatewayVersionForIosRelease,
  resolveIosVersion,
  syncIosVersioning,
} from "../../scripts/lib/ios-version.ts";
import { extractChangelogSection } from "../../scripts/lib/mobile-changelog.ts";
import { installIosFixtureCleanup, writeIosFixture } from "./ios-version.test-support.ts";

installIosFixtureCleanup();
const unreleased = "# OpenClaw iOS Changelog\n\n## Unreleased\n\n";
const fixture = (packageVersion: string) => writeIosFixture({ packageVersion, changelog: "" });
const release = (releaseVersion: string, appStoreRevision?: number) =>
  resolveIosVersion(".", { releaseVersion, appStoreRevision });

describe("resolveIosVersion", () => {
  it("checks archive version inputs without requiring changelog release notes", () => {
    const rootDir = writeIosFixture({ packageVersion: "2026.7.2", changelog: "" });
    fs.rmSync(path.join(rootDir, "apps/ios/CHANGELOG.md"));
    expect(syncIosVersioning({ rootDir, appStoreRevision: 1 })).toEqual({ updatedPaths: [] });
    expect(() => syncIosVersioning({ rootDir, appStoreRevision: 10 })).toThrow(
      "Expected an integer from 0 to 9",
    );
  });

  it("appends one unpadded App Store revision digit to the gateway patch", () => {
    expect(encodeIosAppStoreVersion("2026.7.2", 0)).toBe("2026.7.20");
    expect(encodeIosAppStoreVersion("2026.7.2", 1)).toBe("2026.7.21");
    expect(encodeIosAppStoreVersion("2026.7.2", 9)).toBe("2026.7.29");
    expect(encodeIosAppStoreVersion("2026.7.3", 0)).toBe("2026.7.30");
    expect(encodeIosAppStoreVersion("2026.12.33", 4)).toBe("2026.12.334");
  });

  it("rejects invalid App Store revisions", () => {
    for (const revision of ["-1", "01", "10", "1.5"]) {
      expect(() => normalizeIosAppStoreRevision(revision)).toThrow("integer from 0 to 9");
    }
  });

  it("rejects semver-only package versions", () => {
    expect(() => resolveIosVersion(fixture("1.2.3"))).toThrow("Invalid gateway version");
  });

  it("rejects prerelease suffixes in explicit gateway versions", () => {
    expect(() =>
      resolveIosVersion(fixture("2026.4.6"), { releaseVersion: "2026.4.6-beta.1" }),
    ).toThrow("Expected release version like 2026.6.5");
  });
});

it("uses the base gateway version from package.json", () => {
  expect(resolveGatewayVersionForIosRelease(fixture("2026.4.7-1"))).toEqual({
    packageVersion: "2026.4.7-1",
    pinnedIosVersion: "2026.4.7",
  });
});

describe("release note extraction", () => {
  it("requires exact App Store version notes and adds the gateway association", () => {
    const changelog = `${unreleased}Draft notes.\n\n## 2026.7.21\n\n- App Store revision notes.\n`;
    expect(renderIosReleaseNotes(release("2026.7.2", 1), changelog)).toBe(
      "Gateway version: 2026.7.2\n\n- App Store revision notes.\n",
    );
  });

  it("does not fall back to gateway or Unreleased notes for App Store revisions", () => {
    expect(() =>
      renderIosReleaseNotes(release("2026.7.2", 1), `${unreleased}Draft notes.\n`),
    ).toThrow("Unable to find iOS changelog notes for 2026.7.21");
  });

  it("falls back to Unreleased when the release section does not exist yet", () => {
    const notes = renderIosReleaseNotes(
      release("2026.4.6"),
      `${unreleased}### Added\n\n- New iOS feature.\n`,
    );
    expect(notes).toContain("### Added");
    expect(notes).toContain("- New iOS feature.");
  });

  it("extracts markdown bodies without the version heading", () => {
    expect(
      extractChangelogSection(
        `# OpenClaw iOS Changelog\n\n## 2026.4.6 - 2026-04-06\n\nLine one.\n\n## 2026.4.5\n`,
        "2026.4.6",
      ),
    ).toBe("Line one.");
  });
});
