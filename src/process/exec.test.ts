import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { runCommandWithTimeout, shouldSpawnWithShell } from "./exec.js";

describe("runCommandWithTimeout", () => {
  it("enables shell for known .cmd package-manager wrappers on Windows", () => {
    for (const cmd of ["npm.cmd", "pnpm.cmd", "yarn.cmd", "npx.cmd"]) {
      expect(
        shouldSpawnWithShell({ resolvedCommand: cmd, platform: "win32" }),
      ).toBe(true);
    }
  });

  it("does not enable shell for .cmd wrappers on non-Windows platforms", () => {
    expect(
      shouldSpawnWithShell({ resolvedCommand: "npm.cmd", platform: "linux" }),
    ).toBe(false);
    expect(
      shouldSpawnWithShell({ resolvedCommand: "npm.cmd", platform: "darwin" }),
    ).toBe(false);
  });

  it("does not enable shell for arbitrary commands on Windows", () => {
    expect(
      shouldSpawnWithShell({ resolvedCommand: "node", platform: "win32" }),
    ).toBe(false);
    expect(
      shouldSpawnWithShell({ resolvedCommand: "malicious.cmd", platform: "win32" }),
    ).toBe(false);
    expect(
      shouldSpawnWithShell({ resolvedCommand: "git", platform: "win32" }),
    ).toBe(false);
  });

  it("merges custom env with process.env", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_BASE_ENV"]);
    process.env.OPENCLAW_BASE_ENV = "base";
    try {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          'process.stdout.write((process.env.OPENCLAW_BASE_ENV ?? "") + "|" + (process.env.OPENCLAW_TEST_ENV ?? ""))',
        ],
        {
          timeoutMs: 5_000,
          env: { OPENCLAW_TEST_ENV: "ok" },
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("base|ok");
      expect(result.termination).toBe("exit");
    } finally {
      envSnapshot.restore();
    }
  });

  it("kills command when no output timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setTimeout(() => {}, 120)"],
      {
        timeoutMs: 1_000,
        noOutputTimeoutMs: 35,
      },
    );

    expect(result.termination).toBe("no-output-timeout");
    expect(result.noOutputTimedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("resets no output timer when command keeps emitting output", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        'process.stdout.write("."); setTimeout(() => process.stdout.write("."), 30); setTimeout(() => process.exit(0), 60);',
      ],
      {
        timeoutMs: 1_000,
        noOutputTimeoutMs: 500,
      },
    );

    expect(result.signal).toBeNull();
    expect(result.code ?? 0).toBe(0);
    expect(result.termination).toBe("exit");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.stdout.length).toBeGreaterThanOrEqual(2);
  });

  it("reports global timeout termination when overall timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setTimeout(() => {}, 120)"],
      {
        timeoutMs: 15,
      },
    );

    expect(result.termination).toBe("timeout");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.code).not.toBe(0);
  });
});
