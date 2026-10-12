// No-output timer tests cover idle command timeout and output reset behavior.
import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "./exec.js";

describe("runCommandWithTimeout no-output timer", () => {
  it("resets no-output timeout while the child emits stdout", async () => {
    const script = [
      "let count = 0",
      "let timer",
      "const emit = () => {",
      "  process.stdout.write('.')",
      "  if (++count === 21) { clearInterval(timer); process.exit(0) }",
      "}",
      "emit()",
      "timer = setInterval(emit, 100)",
    ].join(";");
    const result = await runCommandWithTimeout([process.execPath, "-e", script], {
      timeoutMs: 10_000,
      // Leave ample process-startup margin while keeping total runtime above
      // this threshold, so only output-driven resets let the child finish.
      noOutputTimeoutMs: 1_500,
    });

    expect(result).toMatchObject({
      code: 0,
      noOutputTimedOut: false,
      stdout: ".".repeat(21),
      termination: "exit",
    });
  });

  it("marks no-output timeout when the child goes silent", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      {
        timeoutMs: 2_000,
        noOutputTimeoutMs: 100,
      },
    );

    expect(result.termination).toBe("no-output-timeout");
    expect(result.noOutputTimedOut).toBe(true);
    expect(result.code).toBe(124);
  });
});
