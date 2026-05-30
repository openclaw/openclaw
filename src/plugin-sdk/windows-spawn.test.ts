import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginSdkTestHarness } from "./test-helpers.js";
import { materializeWindowsSpawnProgram, resolveWindowsSpawnProgram } from "./windows-spawn.js";

const { createTempDir } = createPluginSdkTestHarness({
  cleanup: {
    maxRetries: 8,
    retryDelay: 8,
  },
});

describe("resolveWindowsSpawnProgram", () => {
  it("rejects node command strings that include inline entrypoint arguments on Windows", () => {
    expect(() =>
      resolveWindowsSpawnProgram({
        command: "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        platform: "win32",
        env: {},
        execPath: "C:\\node\\node.exe",
      }),
    ).toThrow("Windows spawn command must be an executable path only");
  });

  it("allows executable paths with spaces on Windows", () => {
    const resolved = resolveWindowsSpawnProgram({
      command: "C:\\Program Files\\OpenAI Codex\\codex.exe",
      platform: "win32",
      env: {},
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: "C:\\Program Files\\OpenAI Codex\\codex.exe",
      leadingArgv: [],
      resolution: "direct",
      windowsHide: undefined,
    });
  });

  it("fails closed by default for unresolved windows wrappers", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
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

  it("resolves cmd shims that quote an absolute JavaScript entrypoint", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const shimPath = path.join(dir, "qmd.cmd");
    const packageDir = path.join(dir, "node_modules", "@tobilu", "qmd", "dist", "cli");
    await mkdir(packageDir, { recursive: true });
    const entrypoint = path.join(packageDir, "qmd.js");
    await writeFile(entrypoint, "console.log('qmd');\n", "utf8");
    await writeFile(shimPath, `@echo off\r\nnode "${entrypoint}" %*\r\n`, "utf8");

    const resolved = resolveWindowsSpawnProgram({
      command: shimPath,
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });
    const invocation = materializeWindowsSpawnProgram(resolved, ["--version"]);

    expect(invocation).toEqual({
      command: "C:\\node\\node.exe",
      argv: [entrypoint, "--version"],
      resolution: "node-entrypoint",
      shell: undefined,
      windowsHide: true,
    });
  });

  it("only returns shell fallback when explicitly opted in", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
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
