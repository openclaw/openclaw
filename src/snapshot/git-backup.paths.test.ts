import fsSync from "node:fs";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import * as windowsCommand from "../process/windows-command.js";
import { readGitBackupLog } from "./git-backup.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reads backup history when MSYS Git returns a Unix repository root", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.spyOn(fsSync, "existsSync").mockImplementation((file) =>
    String(file).endsWith("msys-2.0.dll"),
  );
  const repository = "C:\\Users\\operator\\backup";
  const success = {
    code: 0,
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
  vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv) => ({
    ...success,
    stdout: argv.includes("--show-toplevel")
      ? "/c/Users/operator/backup\n"
      : argv.includes("symbolic-ref")
        ? "refs/heads/main\n"
        : argv.includes("log")
          ? "abc123\t2026-09-01T00:00:00Z\topenclaw backup\n"
          : "",
  }));
  vi.spyOn(windowsCommand, "resolveSafeChildProcessInvocation").mockReturnValue({
    command: "C:\\msys64\\usr\\bin\\git.exe",
    args: [],
    usesWindowsExitCodeShim: false,
    windowsHide: true,
  });
  vi.spyOn(exec, "runUtf8CommandWithTimeout").mockResolvedValue({
    ...success,
    stdout: `${repository}\n`,
  });
  vi.spyOn(fs, "realpath").mockImplementation(async (value) => {
    if (value !== repository) {
      throw Object.assign(new Error(`ENOENT: ${String(value)}`), { code: "ENOENT" });
    }
    return repository;
  });

  await expect(readGitBackupLog({ repositoryPath: repository, limit: 5 })).resolves.toEqual([
    { commit: "abc123", date: "2026-09-01T00:00:00Z", message: "openclaw backup" },
  ]);
});
