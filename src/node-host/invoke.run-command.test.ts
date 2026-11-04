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

function runNode(source: string, cwd?: string, signal?: AbortSignal) {
  return runCommand([process.execPath, "-e", source], cwd, undefined, undefined, signal);
}

describe("runCommand", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it.runIf(process.platform !== "win32")("preserves signal termination diagnostics", async () => {
    const result = await runNode("process.kill(process.pid, 'SIGTERM')");

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
    const result = await runNode(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')",
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

  describe("Windows cmd.exe shell envelope", () => {
    const shellCommand = 'claude -p "Quel est le rôle du dossier checks ?" --permission-mode plan';

    async function captureLaunch(platform: NodeJS.Platform, argv: string[]) {
      mockProcessPlatform(platform);
      const launch = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockResolvedValueOnce(createCommandResult());
      await runCommand(argv, undefined, undefined, undefined);
      expect(launch).toHaveBeenCalledTimes(1);
      const [launchedArgv, options] = launch.mock.calls[0] ?? [];
      return { launchedArgv, options };
    }

    it("quotes an absolute cmd.exe path regardless of case", async () => {
      const shell = "C:\\Windows\\System32\\CMD.EXE";
      const { launchedArgv, options } = await captureLaunch("win32", [
        shell,
        "/d",
        "/s",
        "/c",
        shellCommand,
      ]);
      expect(launchedArgv).toEqual([shell, "/d", "/s", "/c", `"${shellCommand}"`]);
      expect(options).toMatchObject({ windowsVerbatimArguments: true });
    });

    it.each([
      ["four elements", "win32", ["cmd.exe", "/d", "/s", "/c"]],
      ["another program", "win32", ["powershell.exe", "/d", "/s", "/c", shellCommand]],
      ["/c without /s", "win32", ["cmd.exe", "/d", "/c", "echo", "ready"]],
      ["uppercase switches", "win32", ["cmd.exe", "/D", "/S", "/C", shellCommand]],
      ["another platform", "linux", ["cmd.exe", "/d", "/s", "/c", shellCommand]],
    ] as const)("launches %s unchanged", async (_name, platform, argv) => {
      const { launchedArgv, options } = await captureLaunch(platform, [...argv]);
      expect(launchedArgv).toEqual(argv);
      expect(options).not.toHaveProperty("windowsVerbatimArguments");
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

  describe("working directory failures", () => {
    const enoent = (message: string) => Object.assign(new Error(message), { code: "ENOENT" });

    async function runCommandError(error: NodeJS.ErrnoException, cwd?: string) {
      vi.spyOn(processExec, "runCommandWithTimeout").mockRejectedValueOnce(error);
      return (await runCommand([process.execPath], cwd, undefined, undefined)).error;
    }

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

    it("preserves executable and unrelated errors", async () => {
      const missingExecutable = "spawn /usr/bin/does-not-exist ENOENT";
      expect(await runCommandError(enoent(missingExecutable), os.tmpdir())).toBe(missingExecutable);
      expect(await runCommandError(enoent("spawn /bin/sh ENOENT"), undefined)).toBe(
        "spawn /bin/sh ENOENT",
      );
      const denied = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
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
