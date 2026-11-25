import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveMacosPrlctlInvocation,
  runMacosHostCommand,
  runWindowsHostCommand,
} from "../../scripts/e2e/parallels/macos-exec.ts";

const host = vi.hoisted(() => ({ run: vi.fn(), warn: vi.fn() }));
vi.mock("../../scripts/e2e/parallels/host-command.ts", () => host);

function useHost(platform: NodeJS.Platform, arch = "arm64") {
  vi.stubGlobal("process", { ...process, platform, arch });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("macOS Parallels execution boundary", () => {
  it.each([
    ["macOS", runMacosHostCommand, []],
    ["Windows", runWindowsHostCommand, ["--windows"]],
  ] as const)(
    "preserves %s VM arguments, stdin, and budget without replay",
    (_guest, runCommand, guestArgs) => {
      useHost("darwin");
      const args = ["exec", "Synthetic VM", "--current-user", "/bin/sh -c 'exit 7'"];
      const options = { check: false, input: "guest input\n", timeoutMs: 45_000 };
      const result = { status: 7, stdout: "executed once\n", stderr: "guest error\n" };
      host.run.mockReturnValue(result);

      expect(runCommand("prlctl", args, options)).toBe(result);
      expect(host.run).toHaveBeenCalledExactlyOnceWith(
        "python3",
        [
          "-B",
          fileURLToPath(new URL("../../scripts/e2e/parallels/parallels-exec.py", import.meta.url)),
          "--timeout-ms",
          "45000",
          ...guestArgs,
          "--",
          ...args,
        ],
        options,
      );
    },
  );

  it.each([
    ["linux", "arm64", "prlctl", ["exec", "Linux VM", "true"]],
    ["darwin", "x64", "prlctl", ["exec", "Intel VM", "true"]],
    ["darwin", "arm64", "prlctl", ["snapshot-switch", "VM", "--id", "snapshot"]],
    ["darwin", "arm64", "git", ["rev-parse", "HEAD"]],
  ] as const)("leaves %s/%s %s %j unchanged", (platform, arch, command, args) => {
    useHost(platform, arch);
    expect(resolveMacosPrlctlInvocation(command, [...args], 1000)).toEqual({
      command,
      args,
    });
  });

  it("propagates a transport timeout without running a second client", () => {
    useHost("darwin");
    const error = new Error("transport timed out after output");
    host.run.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => runMacosHostCommand("prlctl", ["exec", "VM", "true"])).toThrow(error);
    expect(host.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    [10_000, 3],
    [60_000, 5],
  ])("bounds persistent startup failures by %i ms and five attempts", (timeoutMs, attempts) => {
    useHost("darwin");
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, milliseconds) => {
      now += milliseconds ?? 0;
      return "timed-out";
    });
    const failure = {
      status: 255,
      stdout: "",
      stderr: "[parallels-exec] Windows guest exit code 0xc0000142\n",
    };
    host.run.mockImplementation(() => {
      now += 1000;
      return failure;
    });
    expect(
      runWindowsHostCommand(
        "prlctl",
        ["exec", "VM", "powershell.exe", "-EncodedCommand", "fixture"],
        { check: false, timeoutMs },
      ),
    ).toBe(failure);
    expect(host.run).toHaveBeenCalledTimes(attempts);
    expect(now).toBeLessThanOrEqual(timeoutMs);
  });

  it("retries PowerShell initialization with the same stdin and one deadline", () => {
    useHost("darwin");
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, milliseconds) => {
      now += milliseconds ?? 0;
      return "timed-out";
    });
    const failure = {
      status: 255,
      stdout: "",
      stderr: "[parallels-exec] Windows guest exit code 0xc0000142\n",
    };
    host.run.mockImplementationOnce(() => {
      now += 1000;
      return failure;
    });
    const success = { status: 0, stdout: "effect once", stderr: "" };
    host.run.mockReturnValueOnce(success);
    const args = ["exec", "VM", "--current-user", "powershell.exe", "-EncodedCommand", "fixture"];
    const options = { check: false, input: "script bytes\n", timeoutMs: 8000 };
    expect(runWindowsHostCommand("prlctl", args, options)).toBe(success);
    expect(host.run).toHaveBeenCalledTimes(2);
    expect(host.run.mock.calls[0]?.[2]).toEqual(options);
    expect(host.run.mock.calls[1]?.[2]).toEqual({ ...options, timeoutMs: 4000 });
    expect(host.run.mock.calls[1]?.[1]).toContain("4000");
    expect(host.warn).toHaveBeenCalledOnce();
  });

  it.each([
    ["powershell.exe", "-EncodedCommand", 255, ""],
    ["powershell.exe", "-EncodedCommand", 125, "SDK error"],
    [
      "powershell.exe",
      "-EncodedCommand",
      255,
      "[parallels-exec] Windows guest exit code 0xc000013a\n",
    ],
    ["powershell.exe", "-File", 255, "[parallels-exec] Windows guest exit code 0xc0000142\n"],
    ["cmd.exe", "/c", 255, "[parallels-exec] Windows guest exit code 0xc0000142\n"],
  ])("never replays %s %s after exit %i (%s)", (program, flag, status, stderr) => {
    useHost("darwin");
    const result = { status, stdout: "", stderr };
    host.run.mockReturnValue(result);
    expect(
      runWindowsHostCommand("prlctl", ["exec", "VM", program, flag, "fixture"], {
        check: false,
        timeoutMs: 30_000,
      }),
    ).toBe(result);
    expect(host.run).toHaveBeenCalledTimes(1);
  });
});

it.skipIf(process.platform === "win32")(
  "enforces SDK ownership, stdio, selection, and cleanup contracts without a real VM",
  () => {
    const fixture = fileURLToPath(new URL("./parallels-exec.test.py", import.meta.url));
    const result = spawnSync("python3", ["-B", fixture], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/\nOK\n/u);
  },
);
