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

  it.runIf(process.platform !== "win32")("preserves signal termination diagnostics", async () => {
    const result = await runCommand(
      [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
      undefined,
      undefined,
      undefined,
    );

    expect(result).toMatchObject({
      exitCode: undefined,
      timedOut: false,
      success: false,
      stdout: "",
      stderr: "",
      error: "Command terminated by signal SIGTERM",
    });
  });

  it.runIf(process.platform !== "win32")("force-kills cancelled command trees", async () => {
    const controller = new AbortController();
    const run = processExec.runCommandWithTimeout;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation((argv, options) =>
      run(argv, {
        ...(typeof options === "number" ? { timeoutMs: options } : options),
        // Cancel only once the real child has installed its signal handler.
        onOutputChunk: () => controller.abort(),
      }),
    );
    const result = await runCommand(
      [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')",
      ],
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(result).toMatchObject({
      timedOut: false,
      success: false,
      stdout: "ready",
      error: "Command terminated by signal SIGKILL",
    });
  });

  describe("working directory failures", () => {
    const enoent = (message: string) =>
      Object.assign(new Error(message), { code: "ENOENT" }) as NodeJS.ErrnoException;

    async function runCommandError(error: NodeJS.ErrnoException, cwd?: string) {
      vi.spyOn(processExec, "runCommandWithTimeout").mockRejectedValueOnce(error);
      return (await runCommand([process.execPath], cwd, undefined, undefined)).error;
    }

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
