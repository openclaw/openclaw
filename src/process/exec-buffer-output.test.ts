import { describe, expect, it } from "vitest";
import { runCommandBuffersWithTimeout, runCommandWithTimeout } from "./exec-runner.js";

describe("owned command output bytes", () => {
  it("retains binary stdout/stderr and the actual exit result", async () => {
    const result = await runCommandBuffersWithTimeout(
      [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0,128,255,65]));process.stderr.write(Buffer.from([255,0,66]));process.exitCode=7;",
      ],
      { timeoutMs: 10_000 },
    );
    expect(result.stdout).toEqual(Buffer.from([0, 128, 255, 65]));
    expect(result.stderr).toEqual(Buffer.from([255, 0, 66]));
    expect(result).toMatchObject({ code: 7, signal: null, termination: "exit" });
  });

  it.each(["text", "bytes"] as const)(
    "keeps the existing bounded tail contract for %s output",
    async (mode) => {
      const command = [
        process.execPath,
        "-e",
        "process.stdout.write('0123456789');process.stderr.write('abcdef');",
      ];
      const options = { timeoutMs: 10_000, maxOutputBytes: { stdout: 4, stderr: 3 } };
      const result =
        mode === "bytes"
          ? await runCommandBuffersWithTimeout(command, options)
          : await runCommandWithTimeout(command, options);
      expect(result.stdout.toString()).toBe("6789");
      expect(result.stderr.toString()).toBe("def");
      expect(result).toMatchObject({
        code: 0,
        termination: "exit",
        stdoutTruncatedBytes: 6,
        stderrTruncatedBytes: 3,
      });
    },
  );

  it("does not start an already canceled byte consumer", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCommandBuffersWithTimeout(
      [process.execPath, "-e", "throw new Error('must not execute');"],
      { timeoutMs: 10_000, signal: controller.signal },
    );
    expect(result).toMatchObject({
      code: null,
      termination: "signal",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    expect(result.pid).toBeUndefined();
  });
});
