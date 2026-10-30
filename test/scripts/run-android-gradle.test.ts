import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveAndroidSdkEnv,
  run,
  shouldSkipLinuxArmAndroidGradle,
  splitAndroidGradleArgs,
} from "../../scripts/run-android-gradle.mts";

const posixIt = process.platform === "win32" ? it.skip : it;

describe("run-android-gradle", () => {
  it("splits Gradle args from an optional post command", () => {
    expect(splitAndroidGradleArgs([":test", "--", "adb", "shell"])).toEqual({
      gradleArgs: [":test"],
      postArgs: ["adb", "shell"],
    });
  });

  it("skips Linux ARM hosts by default because AAPT2 is x86_64-only", () => {
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "arm64", platform: "linux" })).toBe(true);
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "arm", platform: "linux" })).toBe(true);
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "x64", platform: "linux" })).toBe(false);
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "arm64", platform: "darwin" })).toBe(false);
  });

  it("allows an explicit Linux ARM override", () => {
    expect(
      shouldSkipLinuxArmAndroidGradle({
        arch: "arm64",
        env: { OPENCLAW_ANDROID_GRADLE_ALLOW_LINUX_ARM: "1" },
        platform: "linux",
      }),
    ).toBe(false);
  });

  posixIt(
    "reports an unavailable proof prerequisite without starting Gradle or counting tests",
    () => {
      const result = spawnSync(
        process.execPath,
        ["scripts/run-android-gradle.mts", "--proof", ":test"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            JAVA_HOME: "/openclaw-missing-proof-jdk",
            OPENCLAW_ANDROID_GRADLE_ALLOW_LINUX_ARM: "1",
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "prerequisite failure; Gradle was not started and no tests executed",
      );
      expect(result.stderr).toContain("JAVA_HOME");
      expect(result.stderr).not.toContain("Gradle failed after prerequisite checks");
    },
  );

  it.each([
    ["darwin", "/Users/dev", "Library/Android/sdk"],
    ["linux", "/home/dev", "Android/Sdk"],
    ["linux", "/home/dev", ".android-sdk"],
  ] as const)("discovers the %s SDK at %s/%s", (platform, homeDir, suffix) => {
    const sdk = path.join(homeDir, suffix);
    expect(
      resolveAndroidSdkEnv({ env: {}, platform, homeDir, existsSync: (p) => p === sdk }),
    ).toEqual({ ANDROID_HOME: sdk });
  });

  it.each([
    [{ ANDROID_HOME: "/opt/sdk" }, "any"],
    [{ ANDROID_SDK_ROOT: "/opt/sdk" }, "any"],
    [{}, "local.properties"],
    [{}, "none"],
  ] as const)("preserves explicit or unavailable SDK env %j (%s)", (env, existing) => {
    expect(
      resolveAndroidSdkEnv({
        env,
        homeDir: "/Users/dev",
        platform: "darwin",
        existsSync: (p) =>
          existing === "any" || (existing === "local.properties" && p.endsWith(existing)),
      }),
    ).toBe(env);
  });

  it("reports spawn errors and returns a failure status", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const missingCommand = path.join(os.tmpdir(), `openclaw-missing-command-${process.pid}`);
    try {
      await expect(run(missingCommand, [], process.cwd(), {})).resolves.toBe(1);
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0]?.[0])).toContain("ENOENT");
    } finally {
      error.mockRestore();
    }
  });
});
