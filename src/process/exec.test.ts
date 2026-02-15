import { describe, expect, it } from "vitest";
import { runCommandWithTimeout, shouldSpawnWithShell } from "./exec.js";

describe("runCommandWithTimeout", () => {
  it("never enables shell execution (Windows cmd.exe injection hardening)", () => {
    expect(
      shouldSpawnWithShell({
        resolvedCommand: "npm.cmd",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("passes env overrides to child", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", 'process.stdout.write(process.env.OPENCLAW_TEST_ENV ?? "")'],
      {
        timeoutMs: 5_000,
        env: { OPENCLAW_TEST_ENV: "ok" },
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("merges custom env with process.env", async () => {
    const previous = process.env.OPENCLAW_BASE_ENV;
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
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_BASE_ENV;
      } else {
        process.env.OPENCLAW_BASE_ENV = previous;
      }
    }
  });

  it("emits stdout/stderr chunks to callbacks", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        'process.stdout.write("hello"); process.stderr.write("warn"); process.stdout.write(" world")',
      ],
      {
        timeoutMs: 5_000,
        onStdoutChunk: (chunk) => {
          stdoutChunks.push(chunk);
        },
        onStderrChunk: (chunk) => {
          stderrChunks.push(chunk);
        },
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn");
    expect(stdoutChunks.join("")).toBe("hello world");
    expect(stderrChunks.join("")).toBe("warn");
  });
});
