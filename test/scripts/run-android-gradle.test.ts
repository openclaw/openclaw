import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  linuxArmAndroidGradleSkipMessage,
  resolveAndroidSdkEnv,
  run,
  shouldSkipLinuxArmAndroidGradle,
  splitAndroidGradleArgs,
} from "../../scripts/run-android-gradle.mts";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";

const posixIt = process.platform === "win32" ? it.skip : it;

describe("run-android-gradle", () => {
  it("splits Gradle args from an optional post command", () => {
    expect(
      splitAndroidGradleArgs([":app:installPlayDebug", "--", "adb", "shell", "am", "start"]),
    ).toEqual({
      gradleArgs: [":app:installPlayDebug"],
      postArgs: ["adb", "shell", "am", "start"],
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

  it("explains the skip with the override escape hatch", () => {
    expect(linuxArmAndroidGradleSkipMessage("linux", "arm64")).toContain(
      "OPENCLAW_ANDROID_GRADLE_ALLOW_LINUX_ARM=1",
    );
  });

  posixIt(
    "reports an unavailable proof prerequisite without starting Gradle or counting tests",
    () => {
      const result = spawnSync(
        process.execPath,
        ["scripts/run-android-gradle.mts", "--proof", ":wear-shared:testDebugUnitTest"],
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

  posixIt(
    "terminates the active command tree when the wrapper is terminated",
    async ({ signal }) => {
      const moduleUrl = pathToFileURL(path.resolve("scripts/run-android-gradle.mts")).href;
      const childSource = `
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, [
  "-e",
  "setInterval(() => {}, 1_000); process.stdout.write('ready');",
], { stdio: ["ignore", "pipe", "ignore"] });
// Resistance/escalation is covered by managed-child-process.test.ts.
descendant.stdout.once("data", () => {
  process.stdout.write(
    JSON.stringify({ childPid: process.pid, descendantPid: descendant.pid }) + "\\n",
  );
});
setInterval(() => {}, 1_000);
`;
      const runnerSource = `
import { run } from ${JSON.stringify(moduleUrl)};
process.exitCode = await run(
  process.execPath,
  ["-e", ${JSON.stringify(childSource)}],
  process.cwd(),
);
`;
      const runner = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", runnerSource],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const runnerPid = expectPid(runner.pid);
      const processTreeReady = readProcessTree(runner);
      const closed = waitForClose(runner);
      let childPid = 0;
      let descendantPid = 0;

      try {
        const processTree = await withinTest(processTreeReady, signal);
        childPid = processTree.childPid;
        descendantPid = processTree.descendantPid;
        for (const pid of [childPid, descendantPid]) {
          expect({ integer: Number.isInteger(pid), alive: isProcessAlive(pid) }).toEqual({
            integer: true,
            alive: true,
          });
        }

        process.kill(runnerPid, "SIGTERM");
        const result = await withinTest(closed, signal);
        // The owner joins the tree, but Darwin may still expose a reaping descendant's PID.
        await waitForDead(descendantPid, signal);

        expect(isProcessAlive(childPid)).toBe(false);
        expect(isProcessAlive(descendantPid)).toBe(false);
        expect(result).toEqual({ code: 143, signal: null });
      } finally {
        for (const pid of [runnerPid, childPid, descendantPid]) {
          if (pid && isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
        await closed;
      }
    },
  );

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

function expectPid(pid: number | undefined): number {
  if (pid === undefined) {
    throw new Error("expected child process pid");
  }
  return pid;
}

async function readProcessTree(child: ReturnType<typeof spawn>): Promise<{
  childPid: number;
  descendantPid: number;
}> {
  if (!child.stdout) {
    throw new Error("expected child process stdout");
  }
  const lines = createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      return JSON.parse(line);
    }
    throw new Error("runner closed before reporting its process tree");
  } finally {
    lines.close();
  }
}

async function waitForClose(child: ReturnType<typeof spawn>) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
