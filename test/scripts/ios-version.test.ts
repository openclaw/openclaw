import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractChangelogSection,
  renderIosReleaseNotes,
  renderIosVersionXcconfig,
  resolveIosVersion,
} from "../../scripts/lib/ios-version.ts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];

function writeIosFixture(params: { version: string; changelog: string }) {
  const rootDir = makeTempDir(tempDirs, "openclaw-ios-version-");
  fs.mkdirSync(path.join(rootDir, "apps", "ios", "Config"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "apps", "ios", "fastlane", "metadata", "en-US"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(rootDir, "apps", "ios", "version.json"),
    `${JSON.stringify({ version: params.version }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(rootDir, "apps", "ios", "CHANGELOG.md"), params.changelog, "utf8");
  fs.writeFileSync(path.join(rootDir, "apps", "ios", "Config", "Version.xcconfig"), "", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "apps", "ios", "fastlane", "metadata", "en-US", "release_notes.txt"),
    "",
    "utf8",
  );
  return rootDir;
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("resolveIosVersion", () => {
  it("parses stable versions and derives Apple marketing fields", () => {
    const rootDir = writeIosFixture({
      version: "1.2.3",
      changelog: "# OpenClaw iOS Changelog\n\n## 1.2.3\n\nStable notes.\n",
    });

    expect(resolveIosVersion(rootDir)).toMatchObject({
      canonicalVersion: "1.2.3",
      marketingVersion: "1.2.3",
      buildVersion: "1",
      isPrerelease: false,
      prereleaseChannel: null,
      prereleaseNumber: null,
    });
  });

  it("parses beta versions and preserves the base marketing version", () => {
    const rootDir = writeIosFixture({
      version: "1.2.3-beta.4",
      changelog: "# OpenClaw iOS Changelog\n\n## 1.2.3-beta.4\n\nBeta notes.\n",
    });

    expect(resolveIosVersion(rootDir)).toMatchObject({
      canonicalVersion: "1.2.3-beta.4",
      marketingVersion: "1.2.3",
      isPrerelease: true,
      prereleaseChannel: "beta",
      prereleaseNumber: 4,
    });
  });

  it("rejects unsupported prerelease channels", () => {
    const rootDir = writeIosFixture({
      version: "1.2.3-alpha.1",
      changelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\nNotes.\n",
    });

    expect(() => resolveIosVersion(rootDir)).toThrow("Supported prerelease format is x.y.z-beta.N");
  });
});

describe("renderIosVersionXcconfig", () => {
  it("renders checked-in defaults from the canonical iOS version", () => {
    const rootDir = writeIosFixture({
      version: "2.0.1-beta.2",
      changelog: "# OpenClaw iOS Changelog\n\n## 2.0.1-beta.2\n\nNotes.\n",
    });
    const version = resolveIosVersion(rootDir);

    expect(renderIosVersionXcconfig(version)).toContain("OPENCLAW_IOS_VERSION = 2.0.1-beta.2");
    expect(renderIosVersionXcconfig(version)).toContain("OPENCLAW_MARKETING_VERSION = 2.0.1");
    expect(renderIosVersionXcconfig(version)).toContain("OPENCLAW_BUILD_VERSION = 1");
  });
});

describe("release note extraction", () => {
  it("extracts exact version sections first", () => {
    const rootDir = writeIosFixture({
      version: "1.2.3-beta.4",
      changelog: `# OpenClaw iOS Changelog

## Unreleased

Draft notes.

## 1.2.3-beta.4

- Exact beta notes.

## 1.2.3

- Stable notes.
`,
    });
    const version = resolveIosVersion(rootDir);
    const changelog = fs.readFileSync(path.join(rootDir, "apps", "ios", "CHANGELOG.md"), "utf8");

    expect(renderIosReleaseNotes(version, changelog)).toBe("- Exact beta notes.\n");
  });

  it("falls back to the marketing version section when needed", () => {
    const rootDir = writeIosFixture({
      version: "1.2.3-beta.4",
      changelog: `# OpenClaw iOS Changelog

## 1.2.3

- Stable notes.
`,
    });
    const version = resolveIosVersion(rootDir);
    const changelog = fs.readFileSync(path.join(rootDir, "apps", "ios", "CHANGELOG.md"), "utf8");

    expect(renderIosReleaseNotes(version, changelog)).toBe("- Stable notes.\n");
  });

  it("falls back to Unreleased when no release section exists yet", () => {
    const rootDir = writeIosFixture({
      version: "1.2.3",
      changelog: `# OpenClaw iOS Changelog

## Unreleased

### Added

- New iOS feature.
`,
    });
    const version = resolveIosVersion(rootDir);
    const changelog = fs.readFileSync(path.join(rootDir, "apps", "ios", "CHANGELOG.md"), "utf8");

    expect(renderIosReleaseNotes(version, changelog)).toContain("### Added");
    expect(renderIosReleaseNotes(version, changelog)).toContain("- New iOS feature.");
  });

  it("extracts markdown bodies without the version heading", () => {
    expect(
      extractChangelogSection(
        `# OpenClaw iOS Changelog\n\n## 3.0.0 - 2026-04-06\n\nLine one.\n\n## 2.0.0\n`,
        "3.0.0",
      ),
    ).toBe("Line one.");
  });
});
