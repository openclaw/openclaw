import { afterEach, describe, expect, it } from "vitest";
import {
  applyReleaseVersionPlan,
  parseReleaseVersionArgs,
  planReleaseVersion,
} from "../../scripts/release-version.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MACOS_INFO = "apps/macos/Sources/OpenClaw/Resources/Info.plist";
const ANDROID_NOTES = "apps/android/fastlane/metadata/android/en-US/release_notes.txt";
const ANDROID_VERSION = "apps/android/version.json";

function writeFixture() {
  const files = fixtureFiles(tempDirs.make("openclaw-release-version-"));
  const { write, json, read, root } = files;
  json("package.json", { name: "openclaw", version: "2026.6.11", private: true });
  write(
    MACOS_INFO,
    "<plist>\n<dict>\n  <key>CFBundleShortVersionString</key>\n  <string>2026.6.11</string>\n  <key>CFBundleVersion</key>\n  <string>2026061100</string>\n</dict>\n</plist>\n",
  );
  json(ANDROID_VERSION, { version: "2026.7.1", versionCode: 2026070102 });
  write("apps/android/Config/Version.properties", "stale\n");
  write(
    "apps/android/CHANGELOG.md",
    "# Android Changelog\n\n## 2026.7.2\n\n- New release notes.\n\n## 2026.7.1\n\n- Previous release notes.\n",
  );
  write(ANDROID_NOTES, "- Previous release notes.\n");
  return {
    ...files,
    readJson: (file: string) => JSON.parse(read(file)) as Record<string, unknown>,
    apply(version: string) {
      const plan = planReleaseVersion({ android: true, rootDir: root, version });
      applyReleaseVersionPlan(plan);
      return plan;
    },
  };
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
    const f = writeFixture();
    f.apply("2026.7.1-beta.4");

    expect(f.readJson(ANDROID_VERSION)).toEqual({
      version: "2026.7.1",
      versionCode: 2026070102,
    });
    expect(f.read("apps/android/Config/Version.properties")).toContain(
      "OPENCLAW_ANDROID_VERSION_CODE=2026070102",
    );
    expect(f.read(ANDROID_NOTES)).toBe("- Previous release notes.\n");
  });

  it("starts a new Android train at its canonical build code", () => {
    const f = writeFixture();
    const plan = f.apply("2026.7.2-3");

    expect(plan.version).toBe("2026.7.2-3");
    expect(f.readJson("package.json")).toMatchObject({
      name: "openclaw",
      private: true,
      version: "2026.7.2",
    });
    const macosInfo = f.read(MACOS_INFO);
    expect(macosInfo).toContain("<string>2026.7.2</string>");
    expect(macosInfo).toContain("<string>2026070200</string>");
    expect(f.readJson(ANDROID_VERSION)).toEqual({
      version: "2026.7.2",
      versionCode: 2026070201,
    });
    expect(f.read(ANDROID_NOTES)).toBe("- New release notes.\n");
  });

  it("validates every selected file before writing any changes", () => {
    const f = writeFixture();
    const before = f.read("package.json");
    f.write(MACOS_INFO, "<plist><dict></dict></plist>\n");

    expect(() => planReleaseVersion({ rootDir: f.root, version: "2026.7.2-beta.1" })).toThrow(
      "must contain exactly one string value for CFBundleShortVersionString",
    );
    expect(f.read("package.json")).toBe(before);
  });
});
