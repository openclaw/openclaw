import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeWindowsSpawnProgram, resolveWindowsSpawnProgram } from "./windows-spawn.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-windows-spawn-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 8,
    });
  }
});

describe("resolveWindowsSpawnProgram", () => {
  it("fails closed by default for unresolved windows wrappers", async () => {
    const dir = await createTempDir();
    const shimPath = path.join(dir, "wrapper.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    expect(() =>
      resolveWindowsSpawnProgram({
        command: shimPath,
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
        execPath: "C:\\node\\node.exe",
      }),
    ).toThrow(/without shell execution/);
  });

  it("only returns shell fallback when explicitly opted in", async () => {
    const dir = await createTempDir();
    const shimPath = path.join(dir, "wrapper.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    const resolved = resolveWindowsSpawnProgram({
      command: shimPath,
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
      allowShellFallback: true,
    });
    const invocation = materializeWindowsSpawnProgram(resolved, ["--cwd", "C:\\safe & calc.exe"]);

    expect(invocation).toEqual({
      command: shimPath,
      argv: ["--cwd", "C:\\safe & calc.exe"],
      resolution: "shell-fallback",
      shell: true,
      windowsHide: undefined,
    });
  });
});
