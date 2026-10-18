import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  createPnpmRunnerSpawnSpec,
  resolvePnpmRunner,
  type PnpmRunnerParams,
} from "../../scripts/pnpm-runner.mts";
import { buildCmdExeCommandLine } from "../../scripts/windows-cmd-helpers.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const pnpmArgs = ["exec", "vitest", "run"];
const nodeExecPath = "C:\\Program Files\\nodejs\\node.exe";
const comSpec = "C:\\Windows\\System32\\cmd.exe";
function expectRunner(
  params: PnpmRunnerParams,
  command: string,
  args = pnpmArgs,
  windowsVerbatimArguments?: true,
) {
  const expectedArgs = [...args];
  expect(resolvePnpmRunner({ pnpmArgs, ...params })).toEqual({
    shell: false,
    command,
    args: expectedArgs,
    ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
  });
}
function expectCmdRunner(params: PnpmRunnerParams, line: string, command = comSpec) {
  expectRunner({ platform: "win32", ...params }, command, ["/d", "/s", "/c", line], true);
}

const posixIt = process.platform === "win32" ? it.skip : it;

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let fixturesRoot: string;

beforeAll(() => {
  fixturesRoot = tempDirs.make("pnpm-runner-");
  const writeLauncher = (relativePath: string, source: string | Buffer, mode?: number) => {
    const file = path.join(fixturesRoot, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
    if (mode !== undefined) {
      chmodSync(file, mode);
    }
  };
  writeLauncher("js/pnpm.cjs", "console.log('pnpm');\n");
  writeLauncher("shell/pnpm", '#!/bin/sh\nprintf "%s\\n" "$@"\n', 0o755);
  writeLauncher("parent/pnpm", "#!/usr/bin/env node\n", 0o755);
  writeLauncher("corepack/corepack", "#!/bin/sh\nexit 0\n", 0o755);
  writeLauncher("windows/corepack.cmd", "@exit /b 0\r\n");
  for (const [file, marker, exitCode] of [
    ["cwd/pnpm", "cwd", 7],
    ["corepack-only/corepack", "corepack", 9],
  ] as const) {
    writeLauncher(
      `empty-path/${file}`,
      `#!/bin/sh\nprintf '%s\n' '${marker}' "$@"\nexit ${exitCode}\n`,
      0o755,
    );
  }
});

afterEach(() => vi.unstubAllEnvs());

it.each(["exe", "cjs"])("executes pnpm.%s through the correct Windows interpreter", (extension) => {
  const npmExecPath =
    extension === "exe"
      ? "C:\\Users\\test\\AppData\\Local\\pnpm\\pnpm.exe"
      : path.join(fixturesRoot, "js/pnpm.cjs");
  expectRunner(
    { npmExecPath, nodeArgs: ["--no-maglev"], nodeExecPath, platform: "win32" },
    extension === "exe" ? npmExecPath : nodeExecPath,
    extension === "exe" ? pnpmArgs : ["--no-maglev", npmExecPath, ...pnpmArgs],
  );
});

posixIt("executes a shell npm_execpath with its own interpreter", () => {
  const spec = createPnpmRunnerSpawnSpec({
    npmExecPath: path.join(fixturesRoot, "shell/pnpm"),
    pnpmArgs: ["literal & argument"],
    stdio: "pipe",
  });
  const result = spawnSync(spec.command, spec.args, { ...spec.options, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("literal & argument\n");
});

it("wraps an explicit pnpm.cmd path via cmd.exe on Windows", () => {
  expectCmdRunner(
    {
      comSpec,
      npmExecPath: "C:\\Program Files\\pnpm\\pnpm.cmd",
      pnpmArgs: ["exec", "vitest", "run", "-t", "path with spaces"],
    },
    '""C:\\Program Files\\pnpm\\pnpm.cmd" exec vitest run -t "path with spaces""',
  );
});

posixIt("does not resolve parent npm_execpath or PATH for an explicit empty env", () => {
  const tempDir = path.join(fixturesRoot, "parent");
  vi.stubEnv("npm_execpath", path.join(tempDir, "pnpm"));
  vi.stubEnv("PATH", tempDir);
  expectRunner({ env: {}, platform: "linux" }, "pnpm");
});

posixIt("preserves native PATH selection for trailing empty segments", () => {
  const root = path.join(fixturesRoot, "empty-path");
  const cwd = path.join(root, "cwd");
  const env = { PATH: `${path.join(root, "corepack-only")}:` };
  const args = ["run", "build", "literal & argument", ""];
  const expectedOutput = ["cwd", ...args, ""].join("\n");
  const spec = createPnpmRunnerSpawnSpec({
    cwd,
    env,
    npmExecPath: "",
    pnpmArgs: args,
    stdio: "pipe",
  });
  const wrapped = spawnSync(spec.command, spec.args, {
    ...spec.options,
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(wrapped.error).toBeUndefined();
  expect(wrapped).toMatchObject({ status: 7, stdout: expectedOutput, stderr: "" });
});

posixIt("uses Corepack when pnpm is not directly available on PATH", () => {
  expectRunner(
    {
      npmExecPath: "",
      env: { PATH: path.join(fixturesRoot, "corepack") },
      pnpmArgs: ["exec", "tsdown"],
      platform: "darwin",
    },
    path.join(fixturesRoot, "corepack/corepack"),
    ["pnpm", "exec", "tsdown"],
  );
});

it("ignores ambient ComSpec when defaulting the Windows cmd shim launcher", () => {
  expectCmdRunner(
    {
      env: {
        ComSpec: "C:\\Users\\test\\bin\\cmd.exe",
        PATH: "",
        SystemRoot: "D:\\Windows",
      },
      npmExecPath: "",
    },
    "pnpm.cmd exec vitest run",
    "D:\\Windows\\System32\\cmd.exe",
  );
});

it("uses Corepack on Windows when no pnpm shim is available", () => {
  const tempDir = path.join(fixturesRoot, "windows");
  expectCmdRunner(
    {
      comSpec,
      npmExecPath: "",
      env: { Path: tempDir, PATHEXT: ".CMD;.EXE" },
    },
    buildCmdExeCommandLine(path.join(tempDir, "corepack.cmd"), ["pnpm", ...pnpmArgs]),
  );
});

it("builds a shared spawn spec with inherited stdio and env overrides", () => {
  const env = { PATH: "/custom/bin", FOO: "bar" };
  const options = { cwd: "/repo", detached: true, env };
  const spec = createPnpmRunnerSpawnSpec({
    ...options,
    npmExecPath: "",
    pnpmArgs,
    platform: "linux",
  });
  expect(spec).toEqual({
    command: "pnpm",
    args: ["exec", "vitest", "run"],
    options: { ...options, stdio: "inherit", shell: false, windowsVerbatimArguments: undefined },
  });
});
