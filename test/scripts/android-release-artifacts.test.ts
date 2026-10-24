import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifyAndroidReleaseSource } from "../../apps/android/scripts/build-release-artifacts.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "apps/android/scripts/build-release-artifacts.ts";
const APK_CERTIFICATE_SHA256 = "80dbc62315ea216dd6e8a7060735a866ddc464a48ed50fef29ff0550468b9a63";
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const processEnv = { ...process.env };
  delete processEnv.GIT_COMMIT;
  delete processEnv.GIT_SHA;
  delete processEnv.GITHUB_SHA;
  delete processEnv.OPENCLAW_BUILD_TIMESTAMP;
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...processEnv, ...env },
  });
}

type ApkSignerFormat = "legacy" | "V1" | "V2" | "V3.0";

function verifyApk(certificateSha256: string, signerCount = 1, format: ApkSignerFormat = "legacy") {
  const tempRoot = tempRoots.make("openclaw-apksigner-");
  const buildToolsDir = path.join(tempRoot, "build-tools", "36.0.0");
  fs.mkdirSync(buildToolsDir, { recursive: true });
  const apkSignerPath = path.join(buildToolsDir, "apksigner");
  const signerLines = Array.from({ length: signerCount }, (_, index) => {
    const signer =
      format === "legacy"
        ? `Signer #${index + 1}`
        : `${format} Signer${signerCount > 1 ? ` #${index + 1}` : ""}:`;
    return `${signer} certificate SHA-256 digest: ${certificateSha256}`;
  });
  fs.writeFileSync(
    apkSignerPath,
    `#!/bin/sh\nprintf '%s\\n' ${signerLines.map((line) => `'${line}'`).join(" ")}\n`,
  );
  fs.chmodSync(apkSignerPath, 0o755);
  const apkPath = path.join(tempRoot, "OpenClaw-Android.apk");
  fs.writeFileSync(apkPath, "fake apk bytes");
  return run(["--verify-apk", apkPath], { ANDROID_HOME: tempRoot, ANDROID_SDK_ROOT: tempRoot });
}

it("requires release metadata to match a clean checkout", () => {
  const commit = "a".repeat(40);
  const cleanGit = (args: string[]) => (args[0] === "rev-parse" ? `${commit}\n` : "");

  expect(() => verifyAndroidReleaseSource(commit, { runGit: cleanGit })).not.toThrow();
  expect(() => verifyAndroidReleaseSource("b".repeat(40), { runGit: cleanGit })).toThrow(
    "Android release commit mismatch",
  );
  expect(() =>
    verifyAndroidReleaseSource(commit, {
      runGit: (args) => (args[0] === "rev-parse" ? `${commit}\n` : " M app/src/main.kt\n"),
    }),
  ).toThrow("Android release builds require a clean Git checkout");
});

const accepted = "Verified pinned APK signing certificate";
const mismatch = "APK signing certificate mismatch";
const multiple = "Expected exactly one SHA-256 signing certificate";
it.each([
  ["legacy", true, 1, accepted],
  ["V1", true, 1, accepted],
  ["V2", true, 1, accepted],
  ["V3.0", true, 1, accepted],
  ["legacy", false, 1, mismatch],
  ["V2", false, 1, mismatch],
  ["legacy", true, 2, multiple],
  ["V2", true, 2, multiple],
] as const)("verifies %s output: pinned=%s signers=%s", (format, pinned, signers, message) => {
  const result = verifyApk(pinned ? APK_CERTIFICATE_SHA256 : "a".repeat(64), signers, format);
  const success = pinned && signers === 1;
  expect(result.status).toBe(success ? 0 : 1);
  expect(success ? result.stdout : result.stderr).toContain(message);
});
