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
  const write = (file: string, content: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write("package.json", JSON.stringify({ name: "openclaw", version: "2026.6.11", private: true }));
  write(
    MACOS_INFO,
    "<plist>\n<dict>\n  <key>CFBundleShortVersionString</key>\n  <string>2026.6.11</string>\n  <key>CFBundleVersion</key>\n  <string>2026061100</string>\n</dict>\n</plist>\n",
  );
  write(
    "apps/android/version.json",
    JSON.stringify({ version: "2026.7.1", versionCode: 2026070102 }),
  );
  write("apps/android/Config/Version.properties", "stale\n");
  write(
    "apps/android/CHANGELOG.md",
    "# Android Changelog\n\n## 2026.7.2\n\n- New release notes.\n\n## 2026.7.1\n\n- Previous release notes.\n",
  );
  write(ANDROID_NOTES, "- Previous release notes.\n");
  return root;
}

const MACOS_INFO = "apps/macos/Sources/OpenClaw/Resources/Info.plist";
const ANDROID_NOTES = "apps/android/fastlane/metadata/android/en-US/release_notes.txt";
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), "utf8");

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

it("rejects alpha release preparation before reading or changing packages", () => {
  expect(() => planReleaseVersion({ version: "2026.9.24-alpha.1" })).toThrow(
    "Alpha releases are retired;",
  );
});

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

describe("release version planning", () => {
  it("keeps an existing Android build increment on the same release train", () => {
    const root = writeFixture();
    const plan = planReleaseVersion({ android: true, rootDir: root, version: "2026.7.1-beta.4" });
    applyReleaseVersionPlan(plan);

    expect(readJson(path.join(root, "apps", "android", "version.json"))).toEqual({
      version: "2026.7.1",
      versionCode: 2026070102,
    });
    expect(
      fs.readFileSync(path.join(root, "apps", "android", "Config", "Version.properties"), "utf8"),
    ).toContain("OPENCLAW_ANDROID_VERSION_CODE=2026070102");
    expect(read(root, ANDROID_NOTES)).toBe("- Previous release notes.\n");
  });

  it("starts a new Android train at its canonical build code", () => {
    const root = writeFixture();
    const plan = planReleaseVersion({ android: true, rootDir: root, version: "2026.7.2-3" });
    applyReleaseVersionPlan(plan);

    expect(plan.version).toBe("2026.7.2-3");
    expect(readJson(path.join(root, "package.json"))).toMatchObject({
      name: "openclaw",
      private: true,
      version: "2026.7.2",
    });
    const macosInfo = read(root, MACOS_INFO);
    expect(macosInfo).toContain("<string>2026.7.2</string>");
    expect(macosInfo).toContain("<string>2026070200</string>");
    expect(readJson(path.join(root, "apps", "android", "version.json"))).toEqual({
      version: "2026.7.2",
      versionCode: 2026070201,
    });
    expect(read(root, ANDROID_NOTES)).toBe("- New release notes.\n");
  });

  it("validates every selected file before writing any changes", () => {
    const root = writeFixture();
    const packagePath = path.join(root, "package.json");
    const before = fs.readFileSync(packagePath, "utf8");
    fs.writeFileSync(path.join(root, MACOS_INFO), "<plist><dict></dict></plist>\n");

    expect(() => planReleaseVersion({ rootDir: root, version: "2026.7.2-beta.1" })).toThrow(
      "must contain exactly one string value for CFBundleShortVersionString",
    );
    expect(fs.readFileSync(packagePath, "utf8")).toBe(before);
  });
});
