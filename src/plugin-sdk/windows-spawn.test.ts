import { mkdir, rm, writeFile } from "node:fs/promises";
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

  it("resolves relative cmd shims from the caller cwd", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const binDir = path.join(dir, "bin");
    await mkdir(binDir);
    const shimPath = path.join(binDir, "tool.cmd");
    const entrypointPath = path.join(binDir, "tool.js");
    await writeFile(shimPath, '@ECHO off\r\n"%~dp0tool.js" %*\r\n', "utf8");
    await writeFile(entrypointPath, "console.log('ok');\n", "utf8");

    const resolved = resolveWindowsSpawnProgram({
      command: "bin/tool.cmd",
      cwd: dir,
      platform: "win32",
      env: { PATH: "", PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: "C:\\node\\node.exe",
      leadingArgv: [entrypointPath],
      resolution: "node-entrypoint",
      windowsHide: true,
    });
  });

  it("does not inspect bare missing cmd shims from the process cwd", async () => {
    const command = `openclaw-spawn-leak-${process.pid}-${Date.now()}.cmd`;
    const shimPath = path.resolve(command);
    const entrypointPath = path.resolve(command.replace(/\.cmd$/u, ".js"));
    await writeFile(
      shimPath,
      `@ECHO off\r\n"%~dp0${path.basename(entrypointPath)}" %*\r\n`,
      "utf8",
    );
    await writeFile(entrypointPath, "console.log('ok');\n", "utf8");
    try {
      expect(() =>
        resolveWindowsSpawnProgram({
          command,
          platform: "win32",
          env: { PATH: "", PATHEXT: ".CMD;.EXE;.BAT" },
          execPath: "C:\\node\\node.exe",
        }),
      ).toThrow(/PATH is empty/);
    } finally {
      await rm(shimPath, { force: true });
      await rm(entrypointPath, { force: true });
    }
  });

  it("does not inherit parent PATH when an explicit env omits PATH", async () => {
    const originalPath = process.env.PATH;
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    await writeFile(path.join(dir, "leaky.cmd"), '@ECHO off\r\n"%~dp0leaky.js" %*\r\n', "utf8");
    await writeFile(path.join(dir, "leaky.js"), "console.log('ok');\n", "utf8");
    process.env.PATH = dir;
    try {
      expect(() =>
        resolveWindowsSpawnProgram({
          command: "leaky.cmd",
          platform: "win32",
          env: {},
          execPath: "C:\\node\\node.exe",
        }),
      ).toThrow(/PATH is empty/);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
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
