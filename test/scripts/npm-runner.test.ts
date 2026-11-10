import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveNpmRunner, type NpmRunnerParams } from "../../scripts/npm-runner.mts";
import { requireNodeTool } from "../helpers/node-toolchain.js";

const originalVersions = process.versions;
afterEach(() => Object.defineProperty(process, "versions", { value: originalVersions }));
const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
const windowsPath = (name: string) => path.win32.resolve(path.win32.dirname(windowsNode), name);
function runner(npmPath: string, options: NpmRunnerParams = {}) {
  return resolveNpmRunner({
    execPath: windowsNode,
    env: {},
    platform: "win32",
    existsSync: (candidate) => candidate === npmPath,
    ...options,
  });
}

it("loads the npm runner with native Node source imports", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const moduleUrl = pathToFileURL(path.resolve("scripts/npm-runner.mts")).href;
  const result = spawnSync(
    requireNodeTool("node"),
    [
      "--input-type=module",
      "-e",
      `import { resolveNpmRunner } from ${JSON.stringify(moduleUrl)};
process.stdout.write(resolveNpmRunner({ npmArgs: ["--version"] }).args.at(-1));`,
    ],
    { encoding: "utf8", env, timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("--version");
});

it("runs bundled npm under Bun without PATH Node", () => {
  Object.defineProperty(process, "versions", { value: { ...originalVersions, bun: "1.4.3" } });
  const packageJsonPath = createRequire(import.meta.url).resolve("npm/package.json");
  const args = ["pack", "space & literal"];
  expect(resolveNpmRunner({ env: { PATH: "" }, npmArgs: args })).toEqual({
    command: process.execPath,
    args: [path.join(path.dirname(packageJsonPath), "bin", "npm-cli.js"), ...args],
    packageJsonPath,
    shell: false,
  });
});

it.each([
  ["darwin", "/toolchains/bin/node24", "../lib/node_modules/npm/bin/npm-cli.js"],
  ["win32", windowsNode, "node_modules/npm/bin/npm-cli.js"],
] as const)("anchors npm-cli.js to the active %s executable", (platform, execPath, relative) => {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const npmPath = paths.resolve(paths.dirname(execPath), relative);
  expect(runner(npmPath, { platform, execPath, npmArgs: ["pack"] })).toEqual({
    command: execPath,
    args: [npmPath, "pack"],
    shell: false,
    packageJsonPath: paths.resolve(npmPath, "../../package.json"),
  });
});

it("uses an adjacent npm.exe without a shell", () => {
  const command = windowsPath("npm.exe");
  expect(runner(command, { npmArgs: ["install", "--silent"] })).toEqual({
    command,
    args: ["install", "--silent"],
    shell: false,
  });
});

it("quotes npm.cmd paths and caret arguments without shell mode", () => {
  expect(
    runner(windowsPath("npm.cmd"), {
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      npmArgs: ["install", "@slack/bolt@^4.6.0"],
    }),
  ).toEqual({
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npm.cmd" install @slack/bolt@^^4.6.0"'],
    shell: false,
    windowsVerbatimArguments: true,
  });
});

it("ignores ambient ComSpec when wrapping npm.cmd", () => {
  expect(
    runner(windowsPath("npm.cmd"), {
      env: { ComSpec: "C:\\Users\\test\\bin\\cmd.exe", SystemRoot: "D:\\Windows" },
      npmArgs: ["install"],
    }).command,
  ).toBe("D:\\Windows\\System32\\cmd.exe");
});

it("prefixes PATH with the active node dir when falling back to bare npm", () => {
  expect(
    runner("", { execPath: "/tmp/node", env: { PATH: "/usr/bin:/bin" }, platform: "linux" }),
  ).toEqual({
    command: "npm",
    args: [],
    shell: false,
    env: { PATH: `/tmp${path.delimiter}/usr/bin:/bin` },
  });
});

it("fails closed on Windows when no toolchain-local npm CLI exists", () => {
  expect(() => runner("", { env: { Path: "C:\\Windows\\System32" } })).toThrow(
    "OpenClaw refuses to shell out to bare npm on Windows",
  );
});
