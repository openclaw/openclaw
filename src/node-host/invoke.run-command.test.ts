import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import { runCommand } from "./invoke-run-command.js";

describe("runCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures stdout, stderr, and exit status", async () => {
    await expect(
      runCommand(
        [
          process.execPath,
          "-e",
          "process.stdout.write('captured stdout'); process.stderr.write('captured stderr')",
        ],
        undefined,
        undefined,
        undefined,
      ),
    ).resolves.toEqual({
      exitCode: 0,
      timedOut: false,
      success: true,
      stdout: "captured stdout",
      stderr: "captured stderr",
      error: null,
      truncated: false,
    });
  });

  it.each(["before", "after"] as const)(
    "checks node launch policy %s native execution",
    async (timing) => {
      let allowed = timing === "after";
      const pending = runCommand(
        [
          process.execPath,
          "-e",
          "process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('completed'))",
        ],
        undefined,
        { PATH: process.env.PATH ?? "" },
        5_000,
        undefined,
        () => {
          if (!allowed) {
            throw new Error("exec approval changed before execution");
          }
        },
      );
      // The canonical node runner spawns synchronously before returning its promise.
      allowed = false;
      if (timing === "before") {
        await expect(pending).rejects.toThrow("exec approval changed before execution");
      } else {
        const result = await pending;
        expect(result.success).toBe(true);
        expect(result.stdout).toBe("completed");
      }
    },
  );

  it("closes stdin for commands that wait for EOF", async () => {
    await expect(
      runCommand(
        [
          process.execPath,
          "-e",
          "process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('eof'))",
        ],
        undefined,
        undefined,
        2_000,
      ),
    ).resolves.toMatchObject({ success: true, stdout: "eof" });
  });

  it("preserves nonzero command results", async () => {
    await expect(
      runCommand(
        [process.execPath, "-e", "process.stderr.write('failed'); process.exit(7)"],
        undefined,
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({
      exitCode: 7,
      timedOut: false,
      success: false,
      stderr: "failed",
      error: null,
    });
  });

  it.runIf(process.platform !== "win32")("force-kills timed-out command trees", async () => {
    const startedAt = Date.now();
    const result = await runCommand(
      [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      undefined,
      undefined,
      25,
    );
    expect(result).toMatchObject({ timedOut: true, success: false, error: null });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.runIf(process.platform !== "win32")("force-kills cancelled command trees", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const cancelling = setTimeout(() => controller.abort(), 25);
    try {
      const result = await runCommand(
        [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        undefined,
        undefined,
        undefined,
        controller.signal,
      );

      expect(result).toMatchObject({ timedOut: false, success: false, error: null });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      clearTimeout(cancelling);
    }
  });

  it("keeps the combined output prefix bounded", async () => {
    const result = await runCommand(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(200_001))"],
      undefined,
      undefined,
      undefined,
    );
    expect(result.stdout).toHaveLength(200_000);
    expect(result.stdout).toBe("x".repeat(200_000));
    expect(result.truncated).toBe(true);
  });

  it("preserves child launch errors", async () => {
    const result = await runCommand(
      [`openclaw-missing-${process.pid}-${Date.now()}`],
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ exitCode: undefined, timedOut: false, success: false });
    expect(result.error).toMatch(/ENOENT|not found/i);
  });

  describe("working directory failures", () => {
    const enoent = (message: string) =>
      Object.assign(new Error(message), { code: "ENOENT" }) as NodeJS.ErrnoException;

    async function runCommandError(error: NodeJS.ErrnoException, cwd?: string) {
      vi.spyOn(processExec, "runCommandWithTimeout").mockRejectedValueOnce(error);
      return (await runCommand([process.execPath], cwd, undefined, undefined)).error;
    }

    it("blames a missing working directory instead of the shell", async () => {
      const cwd = path.join(os.tmpdir(), `node-exec-missing-${process.pid}-${Date.now()}`);
      expect(await runCommandError(enoent("spawn /bin/sh ENOENT"), cwd)).toBe(
        `node exec working directory does not exist on the node host: ${cwd} (os reported: spawn /bin/sh ENOENT)`,
      );
    });

    it("flags a cwd that exists but is not a directory", async () => {
      const file = path.join(os.tmpdir(), `node-exec-file-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(file, "x");
      try {
        const result = await runCommand(
          [process.execPath, "-e", "process.exit(0)"],
          file,
          undefined,
          undefined,
        );
        expect(result).toMatchObject({ success: false });
        expect(result.error).toContain(
          `node exec working directory is not a directory on the node host: ${file}`,
        );
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it("clarifies a missing cwd during execution", async () => {
      const cwd = path.join(os.tmpdir(), `node-exec-run-missing-${process.pid}-${Date.now()}`);
      const result = await runCommand(
        [process.execPath, "-e", "process.exit(0)"],
        cwd,
        undefined,
        undefined,
      );
      expect(result).toMatchObject({ success: false });
      expect(result.error).toContain(
        `node exec working directory does not exist on the node host: ${cwd}`,
      );
    });

    it("preserves executable and unrelated errors", async () => {
      const missingExecutable = "spawn /usr/bin/does-not-exist ENOENT";
      expect(await runCommandError(enoent(missingExecutable), os.tmpdir())).toBe(missingExecutable);
      expect(await runCommandError(enoent("spawn /bin/sh ENOENT"), undefined)).toBe(
        "spawn /bin/sh ENOENT",
      );
      const denied = Object.assign(new Error("spawn EACCES"), {
        code: "EACCES",
      }) as NodeJS.ErrnoException;
      expect(await runCommandError(denied, "/missing")).toBe("spawn EACCES");
    });

    it("preserves the spawn error when the cwd cannot be inspected", async () => {
      const message = "spawn /bin/sh ENOENT";
      vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      });
      expect(await runCommandError(enoent(message), "/unreadable")).toBe(message);
    });
  });
});
