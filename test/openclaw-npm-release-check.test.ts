import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "../scripts/lib/package-dist-inventory.ts";
import {
  collectForbiddenPackedContentErrors,
  collectForbiddenPackedPathErrors,
  collectPackedTestCargoErrors,
  resolveNpmCommandInvocation,
  runNpmReleaseCheckCommand,
} from "../scripts/openclaw-npm-release-check.ts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("wraps bare Windows npm_execpath through npm.cmd", () => {
  expect(
    resolveNpmCommandInvocation({
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      npmArgs: ["view", "openclaw@beta", "version"],
      npmExecPath: "npm",
      platform: "win32",
    }),
  ).toEqual({
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd view openclaw@beta version"],
    windowsVerbatimArguments: true,
  });
});

if (process.platform === "win32") {
  it("executes fallback npm.cmd through cmd.exe on Windows", () => {
    const dir = tempDirs.make("openclaw-fake-npm-cmd-");
    const outputPath = join(dir, "args.json");
    writeFileSync(
      join(dir, "fake-npm.js"),
      "require('node:fs').writeFileSync(process.env.OPENCLAW_FAKE_NPM_OUT, JSON.stringify(process.argv.slice(2)));",
    );
    writeFileSync(
      join(dir, "npm.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.js" %*\r\n`,
    );
    const invocation = resolveNpmCommandInvocation({
      comSpec: process.env.ComSpec ?? "cmd.exe",
      npmArgs: ["view", "openclaw@beta", "version"],
      npmExecPath: "",
      platform: "win32",
    });
    execFileSync(invocation.command, invocation.args, {
      cwd: dir,
      env: {
        ...process.env,
        OPENCLAW_FAKE_NPM_OUT: outputPath,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      },
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    } as { cwd: string; env: NodeJS.ProcessEnv });
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual([
      "view",
      "openclaw@beta",
      "version",
    ]);
  });
}

it("bounds commands that ignore termination", () => {
  const startedAt = Date.now();
  expect(() =>
    runNpmReleaseCheckCommand(
      {
        command: process.execPath,
        args: ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      },
      { stdio: ["ignore", "pipe", "pipe"], timeoutMs: 100 },
    ),
  ).toThrow();
  expect(Date.now() - startedAt).toBeLessThan(2500);
});

it("rejects private QA and local build artifacts while allowing runtime files", () => {
  expect(
    collectForbiddenPackedPathErrors([
      "dist/index.js",
      "dist-runtime/extensions/example/runtime.js",
      "docs/.generated/config-baseline.json",
      "docs/.generated/config-baseline.plugin.json",
      "dist/OpenClaw.app/Contents/MacOS/OpenClaw",
      "dist/extensions/qa-channel/runtime-api.js",
      "dist/extensions/qa-channel/package.json",
      "dist/extensions/qa-lab/runtime-api.js",
      "dist/extensions/qa-lab/src/cli.js",
      "dist/plugin-sdk/extensions/qa-channel/api.d.ts",
      "dist/plugin-sdk/extensions/qa-lab/cli.d.ts",
      "dist/plugin-sdk/qa-channel.js",
      "dist/plugin-sdk/qa-channel-protocol.d.ts",
      "dist/plugin-sdk/qa-lab.js",
      "dist/plugin-sdk/qa-runtime.d.ts",
      "dist/qa-runtime-B9LDtssJ.js",
      "docs/channels/qa-channel.md",
      "qa/scenarios/index.yaml",
    ]),
  ).toEqual([
    'npm package must not include generated docs artifact "docs/.generated/config-baseline.json".',
    'npm package must not include generated docs artifact "docs/.generated/config-baseline.plugin.json".',
    'npm package must not include local application build output "dist/OpenClaw.app/Contents/MacOS/OpenClaw".',
    'npm package must not include local runtime build output "dist-runtime/extensions/example/runtime.js".',
    'npm package must not include private QA channel artifact "dist/extensions/qa-channel/package.json".',
    'npm package must not include private QA channel artifact "dist/extensions/qa-channel/runtime-api.js".',
    'npm package must not include private QA channel docs "docs/channels/qa-channel.md".',
    'npm package must not include private QA channel SDK artifact "dist/plugin-sdk/qa-channel-protocol.d.ts".',
    'npm package must not include private QA channel SDK artifact "dist/plugin-sdk/qa-channel.js".',
    'npm package must not include private QA channel type artifact "dist/plugin-sdk/extensions/qa-channel/api.d.ts".',
    'npm package must not include private QA lab artifact "dist/extensions/qa-lab/runtime-api.js".',
    'npm package must not include private QA lab artifact "dist/extensions/qa-lab/src/cli.js".',
    'npm package must not include private QA lab SDK artifact "dist/plugin-sdk/qa-lab.js".',
    'npm package must not include private QA lab type artifact "dist/plugin-sdk/extensions/qa-lab/cli.d.ts".',
    'npm package must not include private QA runtime chunk "dist/qa-runtime-B9LDtssJ.js".',
    'npm package must not include private QA runtime SDK artifact "dist/plugin-sdk/qa-runtime.d.ts".',
    'npm package must not include private QA suite artifact "qa/scenarios/index.yaml".',
  ]);
});

it.each([
  ["dist/entry.js", "//#region extensions/qa-lab/src/cli.ts\n", "//#region extensions/qa-lab/"],
  [
    PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
    JSON.stringify(["dist/extensions/qa-lab/runtime-api.js"]),
    "qa-lab/runtime-api.js",
  ],
])("rejects private QA content in %s", (file, content, marker) => {
  const rootDir = tempDirs.make("openclaw-pack-private-qa-");
  mkdirSync(join(rootDir, "dist"));
  writeFileSync(join(rootDir, file), content);
  writeFileSync(join(rootDir, "README.md"), "developer docs mention extensions/qa-lab/\n");
  expect(collectForbiddenPackedContentErrors([file, "README.md"], rootDir)).toEqual([
    `npm package must not include private QA lab marker "${marker}" in "${file}".`,
  ]);
});

it("allows shipped Markdown reference guides", () => {
  expect(
    collectPackedTestCargoErrors([
      "docs/reference/test/local.md",
      "docs/reference/tests/guide.md",
      String.raw`docs\reference\test\docker.md`,
    ]),
  ).toStrictEqual([]);
});
