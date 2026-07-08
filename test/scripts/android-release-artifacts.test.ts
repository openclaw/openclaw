import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "apps/android/scripts/build-release-artifacts.ts";
const APK_CERTIFICATE_SHA256 = "80dbc62315ea216dd6e8a7060735a866ddc464a48ed50fef29ff0550468b9a63";
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
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
  it("selects only the signed third-party APK for GitHub distribution", () => {
    const result = run(["--artifact", "third-party", "--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Release artifact: third-party apk");
    expect(result.stdout).toContain("Gradle task: :app:assembleThirdPartyRelease");
    expect(result.stdout).not.toContain("Release artifact: play aab");
  });

  it("rejects unknown artifact selectors", () => {
    const result = run(["--artifact", "debug", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--artifact must be one of: all, play, third-party");
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
