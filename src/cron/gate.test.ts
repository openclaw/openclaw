/**
 * Unit tests for cron gate script evaluation.
 */

import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { runGate } from "./gate.js";

// Minimal no-op logger satisfying the Logger interface
const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Portable commands that work on both POSIX and Windows.
const TRUE_CMD = platform() === "win32" ? "exit 0" : "true";
const EXIT_1_CMD = platform() === "win32" ? "exit 1" : "exit 1";
const EXIT_2_CMD = platform() === "win32" ? "exit 2" : "exit 2";

describe("runGate", () => {
  it("passes when command exits with default trigger code (0)", async () => {
    const result = await runGate({ command: TRUE_CMD }, log);
    expect(result.passed).toBe(true);
  });

  it("does not pass when command exits with non-zero code", async () => {
    const result = await runGate({ command: EXIT_1_CMD }, log);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(false);
    }
  });

  it("passes when triggerExitCode matches exit code", async () => {
    // Treat exit code 1 as the 'condition met' code.
    const result = await runGate({ command: EXIT_1_CMD, triggerExitCode: 1 }, log);
    expect(result.passed).toBe(true);
  });

  it("does not pass when triggerExitCode does not match", async () => {
    const result = await runGate({ command: EXIT_2_CMD, triggerExitCode: 1 }, log);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.exitCode).toBe(2);
    }
  });

  it("does not pass and sets timedOut when script exceeds timeoutMs", async () => {
    // Sleep for 10 s but kill after 50 ms.
    const sleepCmd = platform() === "win32" ? "timeout /t 10" : "sleep 10";
    const result = await runGate({ command: sleepCmd, timeoutMs: 50 }, log);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.timedOut).toBe(true);
    }
  }, 5_000);

  it("does not pass for empty command and surfaces an error", async () => {
    const result = await runGate({ command: "   " }, log);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.timedOut).toBe(false);
    }
  });

  it("passes on command with shell features (pipeline)", async () => {
    if (platform() === "win32") {
      return;
    } // skip on Windows
    // echo pipes to grep — gate passes if the string is found.
    const result = await runGate({ command: "echo 'hello' | grep -q hello" }, log);
    expect(result.passed).toBe(true);
  });

  it("does not pass when pipeline condition is false", async () => {
    if (platform() === "win32") {
      return;
    } // skip on Windows
    const result = await runGate({ command: "echo 'hello' | grep -q world" }, log);
    expect(result.passed).toBe(false);
  });
});
