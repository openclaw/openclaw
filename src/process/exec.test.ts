import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { runCommandWithTimeout, shouldSpawnWithShell } from "./exec.js";
import {
  PROCESS_TEST_NO_OUTPUT_TIMEOUT_MS,
  PROCESS_TEST_SCRIPT_DELAY_MS,
  PROCESS_TEST_TIMEOUT_MS,
} from "./test-timeouts.js";

describe("runCommandWithTimeout", () => {
  it("never enables shell execution (Windows cmd.exe injection hardening)", () => {
    expect(
      shouldSpawnWithShell({
        resolvedCommand: "npm.cmd",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("merges custom env with process.env", async () => {
    await withEnvAsync({ OPENCLAW_BASE_ENV: "base" }, async () => {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          'process.stdout.write((process.env.OPENCLAW_BASE_ENV ?? "") + "|" + (process.env.OPENCLAW_TEST_ENV ?? ""))',
        ],
        {
          timeoutMs: PROCESS_TEST_TIMEOUT_MS.medium,
          env: { OPENCLAW_TEST_ENV: "ok" },
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("base|ok");
      expect(result.termination).toBe("exit");
    });
  });

  it("kills command when no output timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        `setTimeout(() => {}, ${PROCESS_TEST_SCRIPT_DELAY_MS.silentProcess})`,
      ],
      {
        timeoutMs: PROCESS_TEST_TIMEOUT_MS.standard,
        noOutputTimeoutMs: PROCESS_TEST_NO_OUTPUT_TIMEOUT_MS.exec,
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
        `process.stdout.write(".\\n"); const interval = setInterval(() => process.stdout.write(".\\n"), ${PROCESS_TEST_SCRIPT_DELAY_MS.streamingInterval}); setTimeout(() => { clearInterval(interval); process.exit(0); }, ${PROCESS_TEST_SCRIPT_DELAY_MS.streamingDuration});`,
      ],
      {
        timeoutMs: PROCESS_TEST_TIMEOUT_MS.extraLong,
        noOutputTimeoutMs: PROCESS_TEST_NO_OUTPUT_TIMEOUT_MS.streamingAllowance,
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
      [
        process.execPath,
        "-e",
        `setTimeout(() => {}, ${PROCESS_TEST_SCRIPT_DELAY_MS.silentProcess})`,
      ],
      {
        timeoutMs: PROCESS_TEST_TIMEOUT_MS.short,
      },
    );

    expect(result.termination).toBe("timeout");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.code).not.toBe(0);
  });
});
