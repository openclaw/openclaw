import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = path.resolve("scripts/android-version.ts");

function fixture() {
  const root = tempDirs.make("android-runtime-version-");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "2026.11.17-beta.2" }),
  );
  return root;
}

function version(root: string, plan?: string) {
  const env = { ...process.env };
  delete env.OPENCLAW_ANDROID_RELEASE_PLAN;
  if (plan) {
    env.OPENCLAW_ANDROID_RELEASE_PLAN = plan;
  }
  return spawnSync(
    process.execPath,
    ["--import", "tsx", script, "--for-build", "--json", "--root", root],
    { encoding: "utf8", env },
  );
}

it("derives local builds from the current Gateway without an Android pin or generated files", () => {
  const root = fixture();
  const first = version(root);
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toEqual({
    canonicalVersion: "2026.11.17",
    versionCode: 2026111701,
    wearVersionCode: 2026111751,
  });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.11.18" }));
  const next = version(root);
  expect(next.status, next.stderr).toBe(0);
  expect(JSON.parse(next.stdout)).toMatchObject({
    canonicalVersion: "2026.11.18",
    versionCode: 2026111801,
  });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.11.18-2" }));
  const correction = version(root);
  expect(correction.status, correction.stderr).toBe(0);
  expect(JSON.parse(correction.stdout)).toMatchObject({
    versionCode: 2026111803,
    wearVersionCode: 2026111853,
  });
  expect(fs.readdirSync(root)).toEqual(["package.json"]);
});

it("uses the exact source-bound store plan instead of local defaults", () => {
  const root = fixture();
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "fixture",
  );
  const plan = path.join(root, "plan.json");
  const saved = {
    schemaVersion: 2,
    gatewayVersion: "2026.11.17",
    revision: 2,
    buildNumber: 3,
    version: "2026.11.172",
    versionCode: 2026090452,
    wearVersionCode: 2026090453,
    legacyMaxVersionCode: 2026090451,
    sourceSha: git("rev-parse", "HEAD"),
    releaseNotesBaselines: [
      { audience: "phone", version: null, build: null },
      { audience: "wear", version: null, build: null },
    ],
  };
  fs.writeFileSync(plan, JSON.stringify(saved));
  const result = version(root, plan);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    canonicalVersion: "2026.11.172",
    versionCode: 2026090452,
    wearVersionCode: 2026090453,
  });
  fs.writeFileSync(plan, JSON.stringify({ ...saved, sourceSha: "b".repeat(40) }));
  const rejected = version(root, plan);
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("sourceSha must match the checked-out commit");
});
