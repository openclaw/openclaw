import { describe, expect, it, vi } from "vitest";
import * as ownedBuffer from "../shared/owned-buffer.js";
import {
  runCommandBuffersWithTimeout,
  runCommandWithTimeout,
  runUtf8CommandBuffersWithTimeout,
} from "./exec-runner.js";
import { runCommandBuffered } from "./exec.js";

describe("owned command output bytes", () => {
  it("assembles complete binary output without copying each received chunk", async () => {
    const copy = vi.spyOn(ownedBuffer, "copyOwnedBuffer");
    try {
      const result = await runCommandBuffered(
        [
          process.execPath,
          "-e",
          "process.stdout.write(Buffer.alloc(256 * 1024, 255));process.stderr.write(Buffer.from([0,128,255]));",
        ],
        { timeoutMs: 10_000 },
      );
      expect(result).toMatchObject({ code: 0, termination: "exit" });
      expect(result.stdout).toEqual(Buffer.alloc(256 * 1024, 255));
      expect(result.stderr).toEqual(Buffer.from([0, 128, 255]));
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
    }
  });

  it("keeps incomplete UTF-8 at EOF as the exact observed bytes", async () => {
    const observed: Buffer[] = [];
    const result = await runUtf8CommandBuffersWithTimeout(
      [process.execPath, "-e", "process.stderr.write(Buffer.from([0xf0,0x9f]));"],
      {
        timeoutMs: 10_000,
        onOutputChunk(chunk, stream) {
          if (stream === "stderr") {
            observed.push(chunk);
          }
        },
      },
    );
    expect(result.stderr).toEqual(Buffer.from([0xf0, 0x9f]));
    expect(result.stderr).toEqual(Buffer.concat(observed));
    expect(result).toMatchObject({ code: 0, termination: "exit" });
  });
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
