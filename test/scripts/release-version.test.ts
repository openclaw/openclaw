import { afterEach, expect, it } from "vitest";
import { applyReleaseVersionPlan, planReleaseVersion } from "../../scripts/release-version.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MACOS_INFO = "apps/macos/Sources/OpenClaw/Resources/Info.plist";

function writeFixture() {
  const files = fixtureFiles(tempDirs.make("openclaw-release-version-"));
  const { write, json, read, root } = files;
  json("package.json", { name: "openclaw", version: "2026.6.11", private: true });
  write(
    MACOS_INFO,
    "<plist>\n<dict>\n  <key>CFBundleShortVersionString</key>\n  <string>2026.6.11</string>\n  <key>CFBundleVersion</key>\n  <string>2026061100</string>\n</dict>\n</plist>\n",
  );
  return {
    ...files,
    readJson: (file: string) => JSON.parse(read(file)) as Record<string, unknown>,
    apply(version: string) {
      const plan = planReleaseVersion({ rootDir: root, version });
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
  ["2026.7.1-beta.4", "2026.7.1", "2026070100"],
  ["2026.7.2-3", "2026.7.2", "2026070200"],
] as const)("aligns core and macOS release %s without Android metadata", (version, base, build) => {
  const f = writeFixture();
  expect(f.apply(version).version).toBe(version);
  expect(f.readJson("package.json")).toMatchObject({
    name: "openclaw",
    private: true,
    version: version.includes("-beta") ? version : base,
  });
  expect(f.read(MACOS_INFO)).toContain("<string>" + base + "</string>");
  expect(f.read(MACOS_INFO)).toContain("<string>" + build + "</string>");
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
