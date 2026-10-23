import { spawnSync } from "node:child_process";
import { copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginSdkTestHarness } from "./test-helpers.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgram,
  type ResolveWindowsSpawnProgramParams,
} from "./windows-spawn.js";

const { createTempDir } = createPluginSdkTestHarness({ cleanup: { maxRetries: 8, retryDelay: 8 } });
const resolve = (command: string, options: Partial<ResolveWindowsSpawnProgramParams> = {}) =>
  resolveWindowsSpawnProgram({
    platform: "win32",
    env: {},
    execPath: process.execPath,
    ...options,
    command,
  });

async function createWrapper(content = "@ECHO off\r\necho wrapper\r\n", target?: [string, string]) {
  const dir = await createTempDir("openclaw-windows-spawn-test-");
  const wrapper = path.join(dir, "wrapper.cmd");
  if (target) {
    await writeFile(path.join(dir, target[0]), target[1], "utf8");
  }
  await writeFile(wrapper, content, "utf8");
  return wrapper;
}

describe("resolveWindowsSpawnProgram", () => {
  it.runIf(process.platform === "win32")(
    "resolves mixed-case PATH and PATHEXT keys for a native Windows spawn",
    async () => {
      const dir = await createTempDir("openclaw-windows-spawn-env-case-");
      const executable = path.join(dir, "mixed-env-tool.MiXeD");
      await copyFile(process.execPath, executable);
      const env = { pAtH: dir, pAtHeXt: ".MiXeD" };

      const program = resolve("mixed-env-tool", { env });
      const invocation = materializeWindowsSpawnProgram(program, [
        "-e",
        'process.stdout.write("native-ok")',
      ]);
      const child = spawnSync(invocation.command, invocation.argv, { env, encoding: "utf8" });

      expect(program).toMatchObject({ command: executable, resolution: "direct" });
      expect([child.error, child.status, child.stdout]).toEqual([undefined, 0, "native-ok"]);
    },
  );

  it.each(["node script.js", '"C:\\tools\\pnpm.cmd" exec tool'])(
    "rejects command strings with inline arguments on Windows: %s",
    (command) => {
      expect(() => resolve(command)).toThrow(
        "Windows spawn command must be an executable path only",
      );
    },
  );

  it("preserves an existing launcher path inside a directory with spaces on Windows", async () => {
    const root = await realpath(await createTempDir("openclaw-windows-spawn-test-"));
    const dir = path.join(root, "pnpm checkout");
    await mkdir(dir);
    const launcher = path.join(dir, "launcher.js");
    await writeFile(launcher, "process.exit(0);\n", "utf8");

    expect(materializeWindowsSpawnProgram(resolve(launcher), ["--version"])).toEqual({
      command: process.execPath,
      argv: [launcher, "--version"],
      resolution: "node-entrypoint",
      shell: undefined,
      windowsHide: true,
    });
  });

  it.each(["PATH", "relative command"] as const)(
    "runs a %s launcher from the child cwd",
    async (kind) => {
      const root = await realpath(await createTempDir("openclaw-windows-child-cwd-"));
      const cwd = path.join(root, "child");
      const directory = "node tools";
      const bin = path.join(cwd, directory);
      await mkdir(bin, { recursive: true });
      await writeFile(
        path.join(bin, "entry.cjs"),
        "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n",
      );
      await writeFile(path.join(bin, "tool.cmd"), '@ECHO off\r\n"%~dp0\\entry.cjs" %*\r\n');
      const env = { PATH: directory, PATHEXT: ".CMD" };
      const command = resolveWindowsExecutablePath(
        kind === "PATH" ? "tool" : path.join(directory, "tool.cmd"),
        env,
        cwd,
      );
      const invocation = materializeWindowsSpawnProgram(resolve(command, { env }), [
        "argument with spaces",
      ]);
      const child = spawnSync(invocation.command, invocation.argv, { cwd, encoding: "utf8" });
      expect([child.error, child.status]).toEqual([undefined, 0]);
      expect(JSON.parse(child.stdout)).toEqual({ cwd, args: ["argument with spaces"] });
    },
  );

  it("allows executable paths with spaces on Windows", () => {
    expect(resolve("C:\\Program Files\\OpenAI Codex\\codex.exe")).toEqual({
      command: "C:\\Program Files\\OpenAI Codex\\codex.exe",
      leadingArgv: [],
      resolution: "direct",
      windowsHide: undefined,
    });
  });

  it("fails closed by default for unresolved windows wrappers", async () => {
    const shimPath = await createWrapper();
    expect(() => resolve(shimPath)).toThrow(/without shell execution/);
  });

  it("only returns shell fallback when explicitly opted in", async () => {
    const shimPath = await createWrapper();
    const resolved = resolve(shimPath, { allowShellFallback: true });
    const invocation = materializeWindowsSpawnProgram(resolved, ["--cwd", "C:\\safe & calc.exe"]);

    expect(invocation).toEqual({
      command: shimPath,
      argv: ["--cwd", "C:\\safe & calc.exe"],
      resolution: "shell-fallback",
      shell: true,
      windowsHide: undefined,
    });
  });

  it.each([
    ["custom setup", 'SET WRAPPER_FLAG=1\r\n"%~dp0\\tool.exe" %*', "tool.exe", ""],
    ["forwarded batch", '"%~dp0\\inner.cmd" %*', "inner.cmd", "@ECHO off\r\necho inner\r\n"],
  ])("preserves %s wrappers instead of bypassing their target", async (_, body, name, content) => {
    const wrapperPath = await createWrapper(`@ECHO off\r\n${body}\r\n`, [name, content]);
    expect(resolve(wrapperPath, { allowShellFallback: true })).toEqual({
      command: wrapperPath,
      leadingArgv: [],
      resolution: "shell-fallback",
      shell: true,
    });
  });
});
