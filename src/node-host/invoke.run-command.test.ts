import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import * as processExec from "../process/exec.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { runCommand } from "./invoke-run-command.js";

describe("runCommand", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

  describe("Windows cmd.exe shell envelope", () => {
    const shellCommand = 'claude -p "Quel est le rôle du dossier checks ?" --permission-mode plan';

    async function captureLaunch(platform: NodeJS.Platform, argv: string[]) {
      mockProcessPlatform(platform);
      const launch = vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValueOnce({
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        stdout: "",
        stderr: "",
      });
      await runCommand(argv, undefined, undefined, undefined);
      expect(launch).toHaveBeenCalledTimes(1);
      const [launchedArgv, options] = launch.mock.calls[0] ?? [];
      return { launchedArgv, options };
    }

    it("quotes the node shell command once and passes it verbatim", async () => {
      const { launchedArgv, options } = await captureLaunch(
        "win32",
        buildNodeShellCommand(shellCommand, "win32"),
      );
      expect(launchedArgv).toEqual(["cmd.exe", "/d", "/s", "/c", `"${shellCommand}"`]);
      expect(options).toMatchObject({ windowsVerbatimArguments: true });
    });

    it("recognizes an absolute cmd.exe path regardless of case", async () => {
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
      ["six elements", "win32", ["cmd.exe", "/d", "/s", "/c", shellCommand, "extra"]],
      ["another program", "win32", ["powershell.exe", "/d", "/s", "/c", shellCommand]],
      ["a bare cmd name", "win32", ["cmd", "/d", "/s", "/c", shellCommand]],
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
      {
        name: "with trailing flags",
        suffix: " --permission-mode plan",
        expected: [prompt, "--permission-mode", "plan"],
      },
      {
        name: "when the command begins and ends with quotes",
        suffix: "",
        expected: [prompt],
      },
    ])(
      "delivers a quoted argument with spaces and accents whole to the child ($name)",
      async ({ suffix, expected }) => {
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
