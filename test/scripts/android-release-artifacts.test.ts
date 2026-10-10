import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function fakeApkSigner(certificateSha256: string, signerCount = 1) {
  const tempRoot = tempRoots.make("openclaw-apksigner-");
  const buildToolsDir = path.join(tempRoot, "build-tools", "36.0.0");
  fs.mkdirSync(buildToolsDir, { recursive: true });
  const apkSignerPath = path.join(buildToolsDir, "apksigner");
  const signerLines = Array.from(
    { length: signerCount },
    (_, index) => `Signer #${index + 1} certificate SHA-256 digest: ${certificateSha256}`,
  );
  fs.writeFileSync(
    apkSignerPath,
    `#!/bin/sh\nprintf '%s\\n' ${signerLines.map((line) => `'${line}'`).join(" ")}\n`,
  );
  fs.chmodSync(apkSignerPath, 0o755);
  const apkPath = path.join(tempRoot, "OpenClaw-Android.apk");
  fs.writeFileSync(apkPath, "fake apk bytes");
  return { apkPath, sdkRoot: tempRoot };
}

describe("Android release artifacts", () => {
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

  it("accepts the pinned standalone APK signing certificate", () => {
    const { apkPath, sdkRoot } = fakeApkSigner(APK_CERTIFICATE_SHA256);

    const result = run(["--verify-apk", apkPath], {
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verified pinned APK signing certificate");
  });

  it("rejects an APK signed by another certificate", () => {
    const { apkPath, sdkRoot } = fakeApkSigner("a".repeat(64));

    const result = run(["--verify-apk", apkPath], {
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("APK signing certificate mismatch");
  });

  it("rejects APKs with multiple signers", () => {
    const { apkPath, sdkRoot } = fakeApkSigner(APK_CERTIFICATE_SHA256, 2);

    const result = run(["--verify-apk", apkPath], {
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected exactly one SHA-256 signing certificate");
  });
});
