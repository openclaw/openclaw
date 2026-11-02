import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "../scripts/lib/package-dist-inventory.ts";
import {
  collectForbiddenPackedContentErrors as contentErrors,
  collectForbiddenPackedPathErrors as pathErrors,
  collectPackedTestCargoErrors,
  resolveNpmCommandInvocation,
  runNpmReleaseCheckCommand,
} from "../scripts/openclaw-npm-release-check.ts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const npmArgs = ["view", "openclaw@beta", "version"];
const npmInvocation = (npmExecPath = "", comSpec = process.env.ComSpec ?? "cmd.exe") =>
  resolveNpmCommandInvocation({ npmExecPath, comSpec, npmArgs, platform: "win32" });

it("wraps bare Windows npm_execpath through npm.cmd", () => {
  expect(npmInvocation("npm", "C:\\Windows\\System32\\cmd.exe")).toEqual({
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
    const invocation = npmInvocation();
    execFileSync(invocation.command, invocation.args, {
      cwd: dir,
      env: {
        ...process.env,
        OPENCLAW_FAKE_NPM_OUT: outputPath,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      },
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    } as { cwd: string; env: NodeJS.ProcessEnv });
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(npmArgs);
  });
}

it("bounds commands that ignore termination", () => {
  const command = {
    command: process.execPath,
    args: ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
  };
  const startedAt = Date.now();
  expect(() =>
    runNpmReleaseCheckCommand(command, { stdio: ["ignore", "pipe", "pipe"], timeoutMs: 100 }),
  ).toThrow();
  expect(Date.now() - startedAt).toBeLessThan(2500);
});

it("rejects private QA and local build artifacts while allowing runtime files", () => {
  const forbidden: Array<[string, string]> = [
    ["generated docs artifact", "docs/.generated/config-baseline.json"],
    ["generated docs artifact", "docs/.generated/config-baseline.plugin.json"],
    ["local application build output", "dist/OpenClaw.app/Contents/MacOS/OpenClaw"],
    ["local runtime build output", "dist-runtime/extensions/example/runtime.js"],
    ["private QA channel artifact", "dist/extensions/qa-channel/runtime-api.js"],
    ["private QA channel docs", "docs/channels/qa-channel.md"],
    ["private QA channel SDK artifact", "dist/plugin-sdk/qa-channel-protocol.d.ts"],
    ["private QA channel SDK artifact", "dist/plugin-sdk/qa-channel.js"],
    ["private QA channel type artifact", "dist/plugin-sdk/extensions/qa-channel/api.d.ts"],
    ["private QA lab artifact", "dist/extensions/qa-lab/runtime-api.js"],
    ["private QA lab SDK artifact", "dist/plugin-sdk/qa-lab.js"],
    ["private QA lab type artifact", "dist/plugin-sdk/extensions/qa-lab/cli.d.ts"],
    ["private QA runtime chunk", "dist/qa-runtime-B9LDtssJ.js"],
    ["private QA runtime SDK artifact", "dist/plugin-sdk/qa-runtime.d.ts"],
    ["private QA suite artifact", "qa/scenarios/index.yaml"],
  ];
  const paths = ["dist/index.js", ...forbidden.toReversed().map(([, file]) => file)];
  expect(pathErrors(paths)).toEqual(
    forbidden.map(([kind, file]) => `npm package must not include ${kind} "${file}".`),
  );
});

it.each([
  ["dist/entry.js", "//#region extensions/qa-lab/src/cli.ts\n", "//#region extensions/qa-lab/"],
  ["dist/entry.js", "// extensions/qa-lab/src/cli.ts\n", "// extensions/qa-lab/src/cli.ts"],
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
  expect(contentErrors([file, "README.md"], rootDir)).toEqual([
    `npm package must not include private QA lab marker "${marker}" in "${file}".`,
  ]);
});

it("allows shipped Markdown reference guides", () => {
  const paths = ["test/local.md", "tests/guide.md"].map((file) => `docs/reference/${file}`);
  paths.push(String.raw`docs\reference\test\docker.md`);
  expect(collectPackedTestCargoErrors(paths)).toStrictEqual([]);
});
