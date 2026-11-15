import { afterEach, expect, it } from "vitest";
import { applyReleaseVersionPlan, planReleaseVersion } from "../../scripts/release-version.ts";
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

it.each([
  ["2026.7.1-beta.4", "2026.7.1", 2026070102, "Previous"],
  ["2026.7.2-3", "2026.7.2", 2026070201, "New"],
] as const)(
  "aligns release %s while preserving or starting its Android train",
  (version, base, versionCode, notes) => {
    const f = writeFixture();
    expect(f.apply(version).version).toBe(version);
    expect(f.readJson("package.json")).toMatchObject({
      name: "openclaw",
      private: true,
      version: version.includes("-beta") ? version : base,
    });
    const macosInfo = f.read(MACOS_INFO);
    expect(macosInfo).toContain(`<string>${base}</string>`);
    expect(macosInfo).toContain(`<string>${String(versionCode).slice(0, -2)}00</string>`);
    expect(f.readJson(ANDROID_VERSION)).toEqual({ version: base, versionCode });
    expect(f.read("apps/android/Config/Version.properties")).toContain(
      `OPENCLAW_ANDROID_VERSION_CODE=${versionCode}`,
    );
    expect(f.read(ANDROID_NOTES)).toBe(`- ${notes} release notes.\n`);
  },
);

it("validates every selected file before writing any changes", () => {
  const f = writeFixture();
  const before = f.read("package.json");
  f.write(MACOS_INFO, "<plist><dict></dict></plist>\n");

  expect(() => planReleaseVersion({ rootDir: f.root, version: "2026.7.2-beta.1" })).toThrow(
    "must contain exactly one string value for CFBundleShortVersionString",
  );
  expect(f.read("package.json")).toBe(before);
});
