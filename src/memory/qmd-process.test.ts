import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isWindowsCommandShimEinval,
  resolveCliSpawnInvocation,
  runCliCommand,
} from "./qmd-process.js";

const { resolveWindowsSpawnProgramMock, materializeWindowsSpawnProgramMock, spawnMock } =
  vi.hoisted(() => {
    return {
      resolveWindowsSpawnProgramMock: vi.fn(),
      materializeWindowsSpawnProgramMock: vi.fn(),
      spawnMock: vi.fn(),
    };
  });

vi.mock("../plugin-sdk/windows-spawn.js", () => ({
  resolveWindowsSpawnProgram: resolveWindowsSpawnProgramMock,
  materializeWindowsSpawnProgram: materializeWindowsSpawnProgramMock,
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("qmd-process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveCliSpawnInvocation", () => {
    it("uses .cmd shim for qmd on Windows", () => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      resolveWindowsSpawnProgramMock.mockReturnValueOnce({
        command: "C:/shim/cmd.exe",
        leadingArgv: ["C:/qmd/index.js"],
        resolution: "node-entrypoint",
      });
      materializeWindowsSpawnProgramMock.mockReturnValueOnce({
        command: "C:/shim/cmd.exe",
        argv: ["C:/qmd/index.js", "query"],
        windowsHide: true,
      });

      const result = resolveCliSpawnInvocation({
        command: "qmd",
        args: ["query"],
        env: {},
        packageName: "qmd",
      });

      expect(resolveWindowsSpawnProgramMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "qmd.cmd", platform: "win32" }),
      );
      expect(materializeWindowsSpawnProgramMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "C:/shim/cmd.exe" }),
        ["query"],
      );
      expect(result).toEqual({
        command: "C:/shim/cmd.exe",
        argv: ["C:/qmd/index.js", "query"],
        windowsHide: true,
      });

      platformSpy.mockRestore();
    });

    it("keeps command unchanged on non-Windows platforms", () => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      resolveWindowsSpawnProgramMock.mockReturnValueOnce({
        command: "qmd",
        leadingArgv: [],
        resolution: "direct",
      });
      materializeWindowsSpawnProgramMock.mockReturnValueOnce({
        command: "qmd",
        argv: ["query"],
      });

      resolveCliSpawnInvocation({
        command: "qmd",
        args: ["query"],
        env: {},
        packageName: "qmd",
      });

      expect(resolveWindowsSpawnProgramMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "qmd", platform: "darwin" }),
      );

      platformSpy.mockRestore();
    });
  });

  describe("isWindowsCommandShimEinval", () => {
    it("detects EINVAL errors from .cmd shim invocations", () => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

      expect(
        isWindowsCommandShimEinval({
          err: { code: "EINVAL" },
          command: "C:/Users/fini/AppData/Local/pnpm/qmd.cmd",
          commandBase: "qmd",
        }),
      ).toBe(true);

      expect(
        isWindowsCommandShimEinval({
          err: { code: "ENOENT" },
          command: "C:/Users/fini/AppData/Local/pnpm/qmd.cmd",
          commandBase: "qmd",
        }),
      ).toBe(false);

      expect(
        isWindowsCommandShimEinval({
          err: { code: "EINVAL" },
          command: "C:/Users/fini/AppData/Local/pnpm/node.exe",
          commandBase: "qmd",
        }),
      ).toBe(false);

      platformSpy.mockRestore();
    });
  });

  describe("runCliCommand", () => {
    it("captures stdout/stderr and resolves on exit code 0", async () => {
      const child = createMockChildProcess();
      spawnMock.mockReturnValueOnce(child);

      const promise = runCliCommand({
        commandSummary: "qmd query",
        spawnInvocation: { command: "qmd", argv: ["query"] },
        env: {},
        cwd: "/tmp",
        maxOutputChars: 100,
      });

      child.stdout.emit("data", Buffer.from("hello"));
      child.stderr.emit("data", Buffer.from("warn"));
      child.emit("close", 0);

      await expect(promise).resolves.toEqual({ stdout: "hello", stderr: "warn" });
      expect(spawnMock).toHaveBeenCalledWith("qmd", ["query"], expect.any(Object));
    });

    it("fails when output exceeds maxOutputChars", async () => {
      const child = createMockChildProcess();
      spawnMock.mockReturnValueOnce(child);

      const promise = runCliCommand({
        commandSummary: "qmd query",
        spawnInvocation: { command: "qmd", argv: ["query"] },
        env: {},
        cwd: "/tmp",
        maxOutputChars: 3,
      });

      child.stdout.emit("data", Buffer.from("abcd"));
      child.emit("close", 0);

      await expect(promise).rejects.toThrow("qmd query produced too much output (limit 3 chars)");
    });

    it("fails with stderr text when command exits non-zero", async () => {
      const child = createMockChildProcess();
      spawnMock.mockReturnValueOnce(child);

      const promise = runCliCommand({
        commandSummary: "qmd index",
        spawnInvocation: { command: "qmd", argv: ["index"] },
        env: {},
        cwd: "/tmp",
        maxOutputChars: 100,
      });

      child.stderr.emit("data", Buffer.from("permission denied"));
      child.emit("close", 2);

      await expect(promise).rejects.toThrow("qmd index failed (code 2): permission denied");
    });
  });
});
