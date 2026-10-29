import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  findPrivateKeyMarker,
  PRIVATE_KEY_MARKERS,
  PRIVATE_KEY_SCAN_EXCLUDE,
} from "../../scripts/detect-private-keys.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const script = fileURLToPath(new URL("../../scripts/detect-private-keys.mts", import.meta.url));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runScanner(cwd: string, args: string[] = [], scriptPath = script) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8" });
}

it.each(PRIVATE_KEY_MARKERS)("flags %s anywhere in file bytes", (marker) => {
  expect(findPrivateKeyMarker(Buffer.from(`prefix ${marker} suffix`))).toBe(marker);
});

it("keeps its own source free of literal markers instead of excluding itself", () => {
  const source = fs.readFileSync(script);
  expect(findPrivateKeyMarker(source)).toBeUndefined();
  expect(PRIVATE_KEY_SCAN_EXCLUDE.test("scripts/detect-private-keys.mts")).toBe(false);
});

it("excludes colocated test fixtures and the iOS Fastfile, nothing else", () => {
  expect(PRIVATE_KEY_SCAN_EXCLUDE.test("src/infra/push-apns.test.ts")).toBe(true);
  expect(PRIVATE_KEY_SCAN_EXCLUDE.test("apps/ios/fastlane/Fastfile")).toBe(true);
  expect(PRIVATE_KEY_SCAN_EXCLUDE.test("src/infra/push-apns.ts")).toBe(false);
  expect(PRIVATE_KEY_SCAN_EXCLUDE.test("docs/push-apns.test.ts.md")).toBe(false);
  expect(PRIVATE_KEY_SCAN_EXCLUDE.test("vendor/apps/ios/fastlane/Fastfile.bak")).toBe(false);
});
function createTrackedRepo(files: Record<string, string> = {}) {
  const repoDir = fs.realpathSync(tempDirs.make("detect-private-keys-"));
  const tracked = { "clean.txt": "clean\n", ...files };
  for (const [file, content] of Object.entries(tracked)) {
    fs.writeFileSync(path.join(repoDir, file), content);
  }
  fs.symlinkSync("clean.txt", path.join(repoDir, "link.txt"));
  fs.writeFileSync(path.join(repoDir, "untracked.pem"), "-----BEGIN DSA PRIVATE KEY-----\n");
  expect(spawnSync("git", ["init", "-q", "."], { cwd: repoDir }).status).toBe(0);
  expect(
    spawnSync("git", ["add", "--", ...Object.keys(tracked), "link.txt"], { cwd: repoDir }).status,
  ).toBe(0);
  return repoDir;
}

it("fails with the wrapper trailer when a tracked file carries a key marker", () => {
  const cwd = createTrackedRepo({
    "leaked.pem": "-----BEGIN RSA PRIVATE KEY-----\n",
    "fixture.test.ts": "-----BEGIN EC PRIVATE KEY-----\n",
  });
  // PR CI executes the base-ref scanner outside the candidate tree, without siblings.
  const standaloneCopy = path.join(tempDirs.make("dpk-copy-"), "s.mts");
  fs.copyFileSync(script, standaloneCopy);

  const result = runScanner(cwd, [], standaloneCopy);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Private key found: leaked.pem (BEGIN RSA PRIVATE KEY)");
  expect(result.stderr).not.toContain("fixture.test.ts");
  expect(result.stderr).not.toContain("untracked.pem");
  expect(result.stderr.trimEnd().endsWith("[detect-private-keys] FAILED (exit 1)")).toBe(true);
});

it.each([
  ["clean.txt", 0, "scanned 1 files; no private keys found"],
  ["missing.txt", 1, "ENOENT"],
] as const)("scans only explicit paths and fails closed: %s", (file, status, message) => {
  const cwd = createTrackedRepo({ "leaked.pem": "PuTTY-User-Key-File-2: ssh-rsa\n" });
  const result = runScanner(cwd, [file]);
  expect(result.status).toBe(status);
  expect(status ? result.stderr : result.stdout).toContain(message);
  if (status) {
    expect(result.stderr).toContain("[detect-private-keys] FAILED (exit 1)");
  } else {
    expect(runScanner(cwd).status).toBe(1);
  }
});
