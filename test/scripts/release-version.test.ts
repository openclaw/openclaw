// Release version tests cover one-command core and native version alignment.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyReleaseVersionPlan,
  parseReleaseVersionArgs,
  planReleaseVersion,
} from "../../scripts/release-version.ts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeFixture(): string {
  const root = makeTempDir(tempDirs, "openclaw-release-version-");
  fs.mkdirSync(path.join(root, "apps", "macos", "Sources", "OpenClaw", "Resources"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, "apps", "android", "Config"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps", "android", "fastlane", "metadata", "android", "en-US"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.6.11",
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "apps", "macos", "Sources", "OpenClaw", "Resources", "Info.plist"),
    [
      "<plist>",
      "<dict>",
      "  <key>CFBundleShortVersionString</key>",
      "  <string>2026.6.11</string>",
      "  <key>CFBundleVersion</key>",
      "  <string>2026061100</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "apps", "android", "version.json"),
    `${JSON.stringify(
      {
        version: "2026.7.1",
        versionCode: 2026070102,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(root, "apps", "android", "Config", "Version.properties"), "stale\n");
  fs.writeFileSync(
    path.join(root, "apps", "android", "CHANGELOG.md"),
    [
      "# Android Changelog",
      "",
      "## 2026.7.2",
      "",
      "- New release notes.",
      "",
      "## 2026.7.1",
      "",
      "- Previous release notes.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(
      root,
      "apps",
      "android",
      "fastlane",
      "metadata",
      "android",
      "en-US",
      "release_notes.txt",
    ),
    "- Previous release notes.\n",
  );
  return root;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

it("rejects alpha release preparation before reading or changing packages", () => {
  expect(() => planReleaseVersion({ version: "2026.9.24-alpha.1" })).toThrow(
    "Alpha releases are retired;",
  );
});

describe("release version argument parsing", () => {
  it("keeps last-value ordering and rejects incomplete options after help", () => {
    expect(
      parseReleaseVersionArgs([
        "--write",
        "--version",
        "2026.7.1",
        "--",
        "--check",
        "--version",
        "2026.7.2",
      ]),
    ).toMatchObject({ android: false, mode: "check", version: "2026.7.2" });
    expect(() => parseReleaseVersionArgs(["--help", "--root", "-h"])).toThrow(
      "Missing value for --root.",
    );
    expect(() => parseReleaseVersionArgs(["--version=2026.7.2"])).toThrow(
      "Unknown argument: --version=2026.7.2",
    );
  });
});

describe("release version planning", () => {
  it("keeps an existing Android build increment on the same release train", () => {
    const root = writeFixture();
    const plan = planReleaseVersion({
      android: true,
      rootDir: root,
      version: "2026.7.1-beta.4",
    });
    applyReleaseVersionPlan(plan);

    expect(readJson(path.join(root, "apps", "android", "version.json"))).toEqual({
      version: "2026.7.1",
      versionCode: 2026070102,
    });
    expect(
      fs.readFileSync(path.join(root, "apps", "android", "Config", "Version.properties"), "utf8"),
    ).toContain("OPENCLAW_ANDROID_VERSION_CODE=2026070102");
    expect(
      fs.readFileSync(
        path.join(
          root,
          "apps",
          "android",
          "fastlane",
          "metadata",
          "android",
          "en-US",
          "release_notes.txt",
        ),
        "utf8",
      ),
    ).toBe("- Previous release notes.\n");
  });

  it("starts a new Android train at its canonical build code", () => {
    const root = writeFixture();
    const plan = planReleaseVersion({
      android: true,
      rootDir: root,
      version: "2026.7.2-3",
    });
    applyReleaseVersionPlan(plan);

    expect(plan.version).toBe("2026.7.2-3");
    expect(readJson(path.join(root, "package.json"))).toMatchObject({
      name: "openclaw",
      private: true,
      version: "2026.7.2",
    });
    const macosInfo = fs.readFileSync(
      path.join(root, "apps", "macos", "Sources", "OpenClaw", "Resources", "Info.plist"),
      "utf8",
    );
    expect(macosInfo).toContain("<string>2026.7.2</string>");
    expect(macosInfo).toContain("<string>2026070200</string>");
    expect(readJson(path.join(root, "apps", "android", "version.json"))).toEqual({
      version: "2026.7.2",
      versionCode: 2026070201,
    });
    expect(
      fs.readFileSync(
        path.join(
          root,
          "apps",
          "android",
          "fastlane",
          "metadata",
          "android",
          "en-US",
          "release_notes.txt",
        ),
        "utf8",
      ),
    ).toBe("- New release notes.\n");
  });

  it("validates every selected file before writing any changes", () => {
    const root = writeFixture();
    const packagePath = path.join(root, "package.json");
    const before = fs.readFileSync(packagePath, "utf8");
    fs.writeFileSync(
      path.join(root, "apps", "macos", "Sources", "OpenClaw", "Resources", "Info.plist"),
      "<plist><dict></dict></plist>\n",
    );

    expect(() =>
      planReleaseVersion({
        rootDir: root,
        version: "2026.7.2-beta.1",
      }),
    ).toThrow("must contain exactly one string value for CFBundleShortVersionString");
    expect(fs.readFileSync(packagePath, "utf8")).toBe(before);
  });
});
