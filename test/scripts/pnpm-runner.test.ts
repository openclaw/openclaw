import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPnpmRunnerSpawnSpec, resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { buildCmdExeCommandLine } from "../../scripts/windows-cmd-helpers.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("resolvePnpmRunner", () => {
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

  it.each(["pnpm.exe"])("executes %s directly on Windows", (basename) => {
    const npmExecPath = `C:\\Users\\test\\AppData\\Local\\pnpm\\${basename}`;

    expect(
      resolvePnpmRunner({
        npmExecPath,
        nodeArgs: ["--no-maglev"],
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "win32",
      }),
    ).toEqual({
      command: npmExecPath,
      args: ["exec", "vitest", "run"],
      shell: false,
    });
  });

  posixIt("executes a shell npm_execpath with its own interpreter", () => {
    const tempDir = path.join(fixturesRoot, "shell");
    const npmExecPath = path.join(tempDir, "pnpm");
    const spec = createPnpmRunnerSpawnSpec({
      npmExecPath,
      pnpmArgs: ["literal & argument"],
      stdio: "pipe",
    });
    const result = spawnSync(spec.command, spec.args, { ...spec.options, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("literal & argument\n");
  });

  it("uses pnpm.cjs through node for Windows-style paths", () => {
    const tempDir = path.join(fixturesRoot, "js");
    const npmExecPath = path.join(tempDir, "pnpm.cjs");

    expect(
      resolvePnpmRunner({
        npmExecPath,
        nodeArgs: ["--no-maglev"],
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["--no-maglev", npmExecPath, "exec", "vitest", "run"],
      shell: false,
    });
  });

  it("wraps an explicit pnpm.cmd path via cmd.exe on Windows", () => {
    expect(
      resolvePnpmRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        npmExecPath: "C:\\Program Files\\pnpm\\pnpm.cmd",
        pnpmArgs: ["exec", "vitest", "run", "-t", "path with spaces"],
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\pnpm\\pnpm.cmd" exec vitest run -t "path with spaces""',
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  posixIt("does not resolve parent npm_execpath or PATH for an explicit empty env", () => {
    const tempDir = path.join(fixturesRoot, "parent");
    const npmExecPath = path.join(tempDir, "pnpm");
    vi.stubEnv("npm_execpath", npmExecPath);
    vi.stubEnv("PATH", tempDir);
    expect(
      resolvePnpmRunner({
        env: {},
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "linux",
      }),
    ).toEqual({
      command: "pnpm",
      args: ["exec", "vitest", "run"],
      shell: false,
    });
  });

  posixIt.each([
    { name: "trailing empty", segments: ["corepack-only", ""], marker: "cwd", exitCode: 7 },
  ])("preserves native PATH selection for $name", ({ segments, marker, exitCode }) => {
    const root = path.join(fixturesRoot, "empty-path");
    const cwd = path.join(root, "cwd");
    const env = {
      PATH: segments
        .map((entry) => (entry === "" || entry === "." ? entry : path.join(root, entry)))
        .join(":"),
    };
    const args = ["run", "build", "literal & argument", ""];
    const expectedOutput = [marker, ...args, ""].join("\n");
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
    expect(wrapped.status, wrapped.stderr).toBe(exitCode);
    expect(wrapped.stdout).toBe(expectedOutput);
    expect(wrapped.stderr).toBe("");
  });

  posixIt("uses Corepack when pnpm is not directly available on PATH", () => {
    const tempDir = path.join(fixturesRoot, "corepack");
    const corepackPath = path.join(tempDir, "corepack");

    expect(
      resolvePnpmRunner({
        npmExecPath: "",
        env: { PATH: tempDir },
        pnpmArgs: ["exec", "tsdown"],
        platform: "darwin",
      }),
    ).toEqual({
      command: corepackPath,
      args: ["pnpm", "exec", "tsdown"],
      shell: false,
    });
  });

  it("ignores ambient ComSpec when defaulting the Windows cmd shim launcher", () => {
    expect(
      resolvePnpmRunner({
        env: {
          ComSpec: "C:\\Users\\test\\bin\\cmd.exe",
          PATH: "",
          SystemRoot: "D:\\Windows",
        },
        npmExecPath: "",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "win32",
      }),
    ).toEqual({
      command: "D:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd exec vitest run"],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("uses Corepack on Windows when no pnpm shim is available", () => {
    const tempDir = path.join(fixturesRoot, "windows");
    const corepackPath = path.join(tempDir, "corepack.cmd");

    expect(
      resolvePnpmRunner({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        npmExecPath: "",
        env: { Path: tempDir, PATHEXT: ".CMD;.EXE" },
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        buildCmdExeCommandLine(corepackPath, ["pnpm", "exec", "vitest", "run"]),
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("builds a shared spawn spec with inherited stdio and env overrides", () => {
    const env = { PATH: "/custom/bin", FOO: "bar" };
    expect(
      createPnpmRunnerSpawnSpec({
        cwd: "/repo",
        detached: true,
        npmExecPath: "",
        pnpmArgs: ["exec", "vitest", "run"],
        platform: "linux",
        env,
      }),
    ).toEqual({
      command: "pnpm",
      args: ["exec", "vitest", "run"],
      options: {
        cwd: "/repo",
        detached: true,
        stdio: "inherit",
        env,
        shell: false,
        windowsVerbatimArguments: undefined,
      },
    });
  });
});
