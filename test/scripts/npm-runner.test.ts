import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmRunner, type NpmRunnerParams } from "../../scripts/npm-runner.mts";

const originalVersions = process.versions;
afterEach(() => Object.defineProperty(process, "versions", { value: originalVersions }));

function localRunner(execPath: string, npmPath: string, options: NpmRunnerParams = {}) {
  return resolveNpmRunner({
    execPath,
    env: {},
    existsSync: (candidate) => candidate === npmPath,
    platform: "win32",
    ...options,
  });
}

describe("resolveNpmRunner", () => {
  it("runs bundled npm under the default Bun runtime without PATH Node", () => {
    Object.defineProperty(process, "versions", { value: { ...originalVersions, bun: "1.4.3" } });
    const packageJsonPath = createRequire(import.meta.url).resolve("npm/package.json");
    expect(
      resolveNpmRunner({
        env: { PATH: "" },
        npmArgs: ["pack", "space & literal"],
      }),
    ).toEqual({
      command: process.execPath,
      args: [
        path.join(path.dirname(packageJsonPath), "bin", "npm-cli.js"),
        "pack",
        "space & literal",
      ],
      packageJsonPath,
      shell: false,
    });
  });

  it.each([
    [
      "darwin",
      "/Users/test/.toolchains/node-24/bin/node24",
      "../lib/node_modules/npm/bin/npm-cli.js",
      ["pack", "openclaw@beta"],
    ],
    ["win32", "C:\\nodejs\\node.exe", "node_modules/npm/bin/npm-cli.js", []],
  ] as const)(
    "anchors npm-cli.js to the active %s executable",
    (platform, execPath, relative, args) => {
      const paths = platform === "win32" ? path.win32 : path.posix;
      const npmPath = paths.resolve(paths.dirname(execPath), relative);
      expect(localRunner(execPath, npmPath, { platform, npmArgs: [...args] })).toEqual({
        command: execPath,
        args: [npmPath, ...args],
        packageJsonPath: paths.resolve(npmPath, "../../package.json"),
        shell: false,
      });
    },
  );

  it("uses an adjacent npm.exe on Windows without a shell", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const expectedNpmExePath = path.win32.resolve(path.win32.dirname(execPath), "npm.exe");

    const runner = localRunner(execPath, expectedNpmExePath, { npmArgs: ["install", "--silent"] });
    expect(runner).toEqual({
      command: expectedNpmExePath,
      args: ["install", "--silent"],
      shell: false,
    });
  });

  it.each([
    [
      "C:\\Program Files\\nodejs\\node.exe",
      "--omit=dev",
      '""C:\\Program Files\\nodejs\\npm.cmd" install --omit=dev"',
    ],
    [
      "C:\\nodejs\\node.exe",
      "@slack/bolt@^4.6.0",
      "C:\\nodejs\\npm.cmd install @slack/bolt@^^4.6.0",
    ],
  ])(
    "quotes npm.cmd paths and arguments without shell mode: %s / %s",
    (execPath, argument, commandLine) => {
      const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");
      const runner = localRunner(execPath, npmCmdPath, {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        npmArgs: ["install", argument],
      });

      expect(runner).toEqual({
        command: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", commandLine],
        shell: false,
        windowsVerbatimArguments: true,
      });
    },
  );

  it("ignores ambient ComSpec when wrapping an adjacent npm.cmd on Windows", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    const runner = localRunner(execPath, npmCmdPath, {
      env: {
        ComSpec: "C:\\Users\\test\\bin\\cmd.exe",
        SystemRoot: "D:\\Windows",
      },
      npmArgs: ["install"],
    });

    expect(runner.command).toBe("D:\\Windows\\System32\\cmd.exe");
  });

  it("prefixes PATH with the active node dir when falling back to bare npm", () => {
    expect(
      resolveNpmRunner({
        execPath: "/tmp/node",
        env: { PATH: "/usr/bin:/bin" },
        existsSync: () => false,
        platform: "linux",
      }),
    ).toEqual({
      command: "npm",
      args: [],
      shell: false,
      env: { PATH: `/tmp${path.delimiter}/usr/bin:/bin` },
    });
  });

  it("fails closed on Windows when no toolchain-local npm CLI exists", () => {
    expect(() =>
      resolveNpmRunner({
        execPath: "C:\\node\\node.exe",
        env: { Path: "C:\\Windows\\System32" },
        existsSync: () => false,
        platform: "win32",
      }),
    ).toThrow("OpenClaw refuses to shell out to bare npm on Windows");
  });
});
