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

async function fixture(files: Record<string, string>) {
  const dir = await realpath(await createTempDir("openclaw-windows-spawn-test-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return dir;
}
async function createWrapper(content: string, target?: readonly [string, string]) {
  return path.join(
    await fixture({ "wrapper.cmd": content, ...(target ? { [target[0]]: target[1] } : {}) }),
    "wrapper.cmd",
  );
}
function spawn(
  program: ReturnType<typeof resolve>,
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const invocation = materializeWindowsSpawnProgram(program, argv);
  const child = spawnSync(invocation.command, invocation.argv, { ...options, encoding: "utf8" });
  expect([child.error, child.status]).toEqual([undefined, 0]);
  return child.stdout;
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
      expect(program).toMatchObject({ command: executable, resolution: "direct" });
      expect(spawn(program, ["-e", 'process.stdout.write("native-ok")'], { env })).toBe(
        "native-ok",
      );
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
    const dir = await fixture({ "pnpm checkout/launcher.js": "process.exit(0);\n" });
    const launcher = path.join(dir, "pnpm checkout", "launcher.js");

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
      const directory = "node tools";
      const root = await fixture({
        "child/node tools/entry.cjs":
          "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n",
        "child/node tools/tool.cmd": '@ECHO off\r\n"%~dp0\\entry.cjs" %*\r\n',
      });
      const cwd = path.join(root, "child");
      const env = { PATH: directory, PATHEXT: ".CMD" };
      const command = resolveWindowsExecutablePath(
        kind === "PATH" ? "tool" : path.join(directory, "tool.cmd"),
        env,
        cwd,
      );
      expect(
        JSON.parse(spawn(resolve(command, { env }), ["argument with spaces"], { cwd })),
      ).toEqual({ cwd, args: ["argument with spaces"] });
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

  it.each([
    ["plain", "echo wrapper", undefined],
    ["custom setup", 'SET WRAPPER_FLAG=1\r\n"%~dp0\\tool.exe" %*', ["tool.exe", ""]],
    ["forwarded batch", '"%~dp0\\inner.cmd" %*', ["inner.cmd", "@ECHO off\r\necho inner\r\n"]],
  ] as const)("requires explicit shell opt-in for %s wrappers", async (_, body, target) => {
    const shim = await createWrapper(`@ECHO off\r\n${body}\r\n`, target);
    expect(() => resolve(shim)).toThrow(/without shell execution/);
    const args = ["--cwd", "C:\\safe & calc.exe"];
    expect(
      materializeWindowsSpawnProgram(resolve(shim, { allowShellFallback: true }), args),
    ).toEqual({
      command: shim,
      argv: args,
      resolution: "shell-fallback",
      shell: true,
      windowsHide: undefined,
    });
  });
});
