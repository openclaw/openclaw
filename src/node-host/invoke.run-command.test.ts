import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import * as processExec from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { runCommand } from "./invoke-run-command.js";
import { applyOutputTruncation } from "./invoke-system-run-allowlist.js";

function runNode(source: string, cwd?: string, signal?: AbortSignal) {
  return runCommand([process.execPath, "-e", source], cwd, undefined, undefined, signal);
}

describe("runCommand", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(vi.restoreAllMocks);

  it("does not revoke an already-launched native command", async () => {
    let allowed = true;
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
    await expect(pending).resolves.toMatchObject({ success: true, stdout: "completed" });
  });

  it.runIf(process.platform === "linux")(
    "restores the service PATH after login startup and resolves service-only tools",
    async () => {
      const home = tempDirs.make("openclaw-node-service-path-");
      fs.writeFileSync(path.join(home, ".profile"), "export PATH=/usr/bin:/bin\n");
      const serviceBin = path.join(home, "service bin");
      fs.mkdirSync(serviceBin);
      fs.writeFileSync(path.join(serviceBin, "openclaw-path-probe"), "#!/bin/sh\nprintf service", {
        mode: 0o755,
      });
      const servicePath = `${serviceBin}:/usr/bin:/bin`;
      const result = await runCommand(
        buildNodeShellCommand('printf "%s\\n" "$PATH"; openclaw-path-probe', "linux"),
        undefined,
        { HOME: home, PATH: servicePath, OPENCLAW_PREPEND_PATH: "/request-override" },
        undefined,
      );
      expect(result).toMatchObject({ success: true, stderr: "" });
      const [childPath, output] = result.stdout.split("\n");
      expect(childPath?.startsWith(`${servicePath}:`)).toBe(true);
      expect(output).toBe("service");
    },
  );

  it.runIf(process.platform !== "win32").each([false, true])(
    "preserves signal diagnostics (cancelled tree: %s)",
    async (cancelled) => {
      const controller = new AbortController();
      if (cancelled) {
        const run = processExec.runCommandWithTimeout;
        vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation((argv, options) =>
          run(argv, {
            ...(typeof options === "number" ? { timeoutMs: options } : options),
            // Cancel after the real child installs its SIGTERM handler.
            onOutputChunk: () => controller.abort(),
          }),
        );
      }
      const result = await runNode(
        cancelled
          ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')"
          : "process.kill(process.pid, 'SIGTERM')",
        undefined,
        controller.signal,
      );
      expect(result).toMatchObject({
        exitCode: undefined,
        timedOut: false,
        success: false,
        stderr: "",
        stdout: cancelled ? "ready" : "",
        error: `Command terminated by signal ${cancelled ? "SIGKILL" : "SIGTERM"}`,
      });
    },
  );

  describe("Windows cmd.exe shell envelope", () => {
    const shellCommand = 'claude -p "Quel est le rôle du dossier checks ?" --permission-mode plan';

    const shell = "C:\\Windows\\System32\\CMD.EXE";
    it.each([
      ["absolute mixed-case shell", "win32", [shell, "/d", "/s", "/c", shellCommand], true],
      ["four elements", "win32", ["cmd.exe", "/d", "/s", "/c"], false],
      ["another program", "win32", ["powershell.exe", "/d", "/s", "/c", shellCommand], false],
      ["/c without /s", "win32", ["cmd.exe", "/d", "/c", "echo", "ready"], false],
      ["uppercase switches", "win32", ["cmd.exe", "/D", "/S", "/C", shellCommand], false],
      ["another platform", "linux", ["cmd.exe", "/d", "/s", "/c", shellCommand], false],
    ] as const)("launches %s", async (_name, platform, argv, verbatim) => {
      mockProcessPlatform(platform);
      const launch = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockResolvedValueOnce(createCommandResult());
      await runCommand([...argv], undefined, undefined, undefined);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0]?.[0]).toEqual(
        verbatim ? [shell, "/d", "/s", "/c", `"${shellCommand}"`] : argv,
      );
      const options = launch.mock.calls[0]?.[1];
      if (verbatim) {
        expect(options).toHaveProperty("windowsVerbatimArguments", true);
      } else {
        expect(options).not.toHaveProperty("windowsVerbatimArguments");
      }
    });

    const prompt = "Quel est le rôle du dossier checks ?";
    it.runIf(process.platform === "win32").each([
      [" --permission-mode plan", [prompt, "--permission-mode", "plan"]],
      ["", [prompt]],
    ] as const)(
      "delivers quoted spaces and accents whole with suffix %j",
      async (suffix, expected) => {
        const source =
          "process.stdout.write(encodeURIComponent(JSON.stringify(process.argv.slice(1))))";
        const result = await runCommand(
          buildNodeShellCommand(
            `"${process.execPath}" -e "${source}" "${prompt}"${suffix}`,
            "win32",
          ),
          undefined,
          undefined,
          30_000,
        );
        expect(result).toMatchObject({ success: true, error: null });
        expect(JSON.parse(decodeURIComponent(result.stdout))).toEqual(expected);
      },
    );
  });

  it("keeps the end of output that exceeds the node output cap", async () => {
    const result = await runNode(
      "process.stdout.write('FIRST_LINE\\n' + 'x'.repeat(250_000) + '\\nFAILED: 3 tests\\n'); process.exitCode = 2",
    );

    expect(result).toMatchObject({ exitCode: 2, success: false, truncated: true });
    expect(result.stdout.endsWith("\nFAILED: 3 tests\n")).toBe(true);
    expect(result.stdout).not.toContain("FIRST_LINE");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(200_000);

    applyOutputTruncation(result);
    expect(result.stdout.startsWith("... (truncated)\n")).toBe(true);
    expect(result.stdout.endsWith("\nFAILED: 3 tests\n")).toBe(true);
  });

  it("marks dropped output before stderr when only stderr was kept", () => {
    const result = {
      exitCode: 1,
      timedOut: false,
      success: false,
      stdout: "",
      stderr: "error: build failed\n",
      error: null,
      truncated: true,
    };

    applyOutputTruncation(result);

    expect(result).toMatchObject({ stdout: "", stderr: "... (truncated)\nerror: build failed\n" });
  });

  it("keeps the end of stderr when combined output exceeds the cap", async () => {
    const result = await runNode(
      "process.stdout.write('o'.repeat(150_000)); process.stderr.write('e'.repeat(150_000) + '\\nerror: build failed\\n'); process.exitCode = 1",
    );

    expect(result).toMatchObject({ exitCode: 1, truncated: true });
    expect(result.stderr.endsWith("\nerror: build failed\n")).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      200_000,
    );
  });

  describe("working directory failures", () => {
    const errno = (message: string, code = "ENOENT") => Object.assign(new Error(message), { code });

    it.each(["is not a directory", "does not exist"])("clarifies a cwd that %s", async (reason) => {
      const cwd = path.join(tempDirs.make("openclaw-node-cwd-"), "cwd");
      if (reason === "is not a directory") {
        fs.writeFileSync(cwd, "x");
      }
      const result = await runNode("process.exit(0)", cwd);
      expect(result).toMatchObject({ success: false });
      expect(result.error).toContain(
        `node exec working directory ${reason} on the node host: ${cwd}`,
      );
    });

    it.each([
      ["missing executable", errno("spawn /usr/bin/does-not-exist ENOENT"), os.tmpdir(), false],
      ["absent cwd", errno("spawn /bin/sh ENOENT"), undefined, false],
      ["unrelated error", errno("spawn EACCES", "EACCES"), "/missing", false],
      ["unreadable cwd", errno("spawn /bin/sh ENOENT"), "/unreadable", true],
    ] as const)("preserves %s", async (_name, error, cwd, unreadable) => {
      if (unreadable) {
        vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        });
      }
      vi.spyOn(processExec, "runCommandWithTimeout").mockRejectedValueOnce(error);
      expect((await runCommand([process.execPath], cwd, undefined, undefined)).error).toBe(
        error.message,
      );
    });
  });
});
