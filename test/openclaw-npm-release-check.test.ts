import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "../scripts/lib/package-dist-inventory.ts";
import { parseReleaseVersion } from "../scripts/lib/release-version.mjs";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../scripts/lib/workspace-bootstrap-smoke.mts";
import { assertPreparedOpenClawAiDependency } from "../scripts/openclaw-npm-prepublish-verify.ts";
import {
  collectControlUiPackErrors,
  collectForbiddenPackedContentErrors,
  collectForbiddenPackedPathErrors,
  collectPackedTestCargoErrors,
  collectReleasePackageMetadataErrors,
  collectReleaseTagErrors,
  parseNpmPackJsonOutput,
  resolveNpmCommandInvocation,
  resolveNpmReleaseCheckCommandTimeoutMs,
  runNpmReleaseCheckCommand,
} from "../scripts/openclaw-npm-release-check.ts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("requires the packed root to depend on the exact prepared AI version", () => {
  const aiManifest = { name: "@openclaw/ai", version: "2026.7.2" };
  const rootManifest = {
    name: "openclaw",
    version: "2026.7.2",
    dependencies: { "@openclaw/ai": "2026.7.2" },
  };
  expect(() =>
    assertPreparedOpenClawAiDependency({
      aiManifest,
      rootManifest: { ...rootManifest, version: "2026.7.1" },
    }),
  ).toThrow("Prepared root and @openclaw/ai tarballs must both be version 2026.7.2.");
  expect(() =>
    assertPreparedOpenClawAiDependency({
      aiManifest,
      rootManifest: { ...rootManifest, dependencies: { "@openclaw/ai": "2026.7.1" } },
    }),
  ).toThrow("Prepared root tarball must depend on exact @openclaw/ai@2026.7.2.");
  expect(() => assertPreparedOpenClawAiDependency({ aiManifest, rootManifest })).not.toThrow();
});

it("rejects unsafe numeric release components", () => {
  expect(parseReleaseVersion("2026.3.9007199254740993")).toBeNull();
  expect(parseReleaseVersion("2026.3.10-beta.9007199254740993")).toBeNull();
  expect(parseReleaseVersion("2026.3.10-alpha.9007199254740993")).toBeNull();
  expect(parseReleaseVersion("2026.3.10-9007199254740993")).toBeNull();
});

it("falls back to npm when npm_execpath points to pnpm", () => {
  expect(
    resolveNpmCommandInvocation({
      npmArgs: ["pack"],
      npmExecPath: "/home/test/.cache/node/corepack/v1/pnpm/10.23.0/bin/pnpm.cjs",
      nodeExecPath: "/usr/local/bin/node",
      platform: "linux",
    }),
  ).toEqual({ command: "npm", args: ["pack"] });
});

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

it("quotes Windows npm command shims and tarball paths containing spaces", () => {
  expect(
    resolveNpmCommandInvocation({
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      npmArgs: ["install", "-g", "C:\\tmp\\openclaw package.tgz"],
      npmExecPath: "C:\\Program Files\\nodejs\\npm.cmd",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    }),
  ).toEqual({
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\nodejs\\npm.cmd" install -g "C:\\tmp\\openclaw package.tgz""',
    ],
    windowsVerbatimArguments: true,
  });
});

it("runs Windows npm_execpath executables directly", () => {
  expect(
    resolveNpmCommandInvocation({
      npmArgs: ["--version"],
      npmExecPath: "C:\\Program Files\\nodejs\\npm.exe",
      platform: "win32",
    }),
  ).toEqual({ command: "C:\\Program Files\\nodejs\\npm.exe", args: ["--version"] });
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

it("bounds captured command output", () => {
  expect(() =>
    runNpmReleaseCheckCommand(
      { command: process.execPath, args: ["--eval", "process.stdout.write('x'.repeat(4096))"] },
      { maxBuffer: 1024, stdio: ["ignore", "pipe", "pipe"] },
    ),
  ).toThrow();
});

it("parses only positive integer environment timeouts", () => {
  const timeout = (raw: string) =>
    resolveNpmReleaseCheckCommandTimeoutMs({ OPENCLAW_NPM_RELEASE_CHECK_COMMAND_TIMEOUT_MS: raw });
  expect(resolveNpmReleaseCheckCommandTimeoutMs({})).toBe(10 * 60 * 1000);
  expect(timeout("")).toBe(10 * 60 * 1000);
  expect(timeout("1234")).toBe(1234);
  for (const raw of ["nope", "10m", "1e3", "0", "-1", "9007199254740992"]) {
    expect(() => timeout(raw)).toThrow(
      `invalid OPENCLAW_NPM_RELEASE_CHECK_COMMAND_TIMEOUT_MS: ${raw}`,
    );
  }
});

it("preserves filename-only pnpm receipts and npm size metadata", () => {
  const receipt = { filename: "openclaw.tgz", unpackedSize: 120_354_302 };
  expect(parseNpmPackJsonOutput(JSON.stringify(receipt))).toEqual([receipt]);
  expect(parseNpmPackJsonOutput(JSON.stringify({ filename: receipt.filename }))).toEqual([
    { filename: receipt.filename },
  ]);
});

it.each([
  '[{"filename":"openclaw.tgz","files":[{"path":"dist/control-ui/index.html"}]}]',
  '{"openclaw":{"filename":"openclaw.tgz","files":[{"path":"dist/control-ui/index.html"}]}}',
])("parses trailing npm pack JSON after lifecycle logs: %s", (json) => {
  expect(parseNpmPackJsonOutput(`> openclaw@2026.7.2 prepack\n${json}`)).toEqual([
    { filename: "openclaw.tgz", files: [{ path: "dist/control-ui/index.html" }] },
  ]);
});

it("rejects an incomplete packed file inventory", () => {
  expect(
    parseNpmPackJsonOutput(
      JSON.stringify([
        { filename: "openclaw.tgz", files: [{ path: "dist/control-ui/index.html" }, {}] },
      ]),
    ),
  ).toBeNull();
});

it("rejects dashboard HTML without the bundled asset payload", () => {
  expect(
    collectControlUiPackErrors([
      "dist/control-ui/index.html",
      PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
      ...WORKSPACE_TEMPLATE_PACK_PATHS,
    ]),
  ).toEqual([
    'npm package is missing Control UI asset payload under "dist/control-ui/assets/". Refuse release when the dashboard tarball would be empty.',
  ]);
});

it("rejects private QA and local build artifacts while allowing runtime files", () => {
  expect(
    collectForbiddenPackedPathErrors([
      "dist/index.js",
      "dist-runtime/extensions/example/runtime.js",
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

it("still rejects test code in docs and Markdown fixtures outside root docs", () => {
  const paths = [
    "dist/node_modules/example/docs/test/fixture.md",
    "docs/reference/example.test.ts",
    "docs/reference/test/example.js",
    "test/fixtures/docs/guide.md",
  ];
  expect(collectPackedTestCargoErrors(paths)).toEqual(
    paths.map((path) => `npm package must not include test cargo "${path}".`),
  );
});

it("allows legitimate package roots named test under node_modules", () => {
  expect(
    collectPackedTestCargoErrors([
      "dist/extensions/fixture-plugin/node_modules/direct/node_modules/test/index.js",
      "dist/extensions/fixture-plugin/node_modules/direct/node_modules/@scope/tests/index.js",
    ]),
  ).toStrictEqual([]);
});

it("allows leaf runtime filenames named test or tests", () => {
  expect(
    collectPackedTestCargoErrors([
      "dist/extensions/fixture-plugin/node_modules/direct/bin/test",
      "dist/extensions/fixture-plugin/node_modules/direct/bin/tests",
    ]),
  ).toStrictEqual([]);
});

it("normalizes Windows or mixed separators before classifying test cargo", () => {
  expect(
    collectPackedTestCargoErrors([
      String.raw`dist\extensions\fixture-plugin\node_modules\direct\__tests__\index.js`,
      String.raw`dist/extensions/fixture-plugin\node_modules/direct/src/runtime.spec.ts`,
      String.raw`dist\extensions\fixture-plugin\node_modules\direct\node_modules\test\index.js`,
    ]),
  ).toEqual([
    `npm package must not include test cargo "${String.raw`dist/extensions/fixture-plugin\node_modules/direct/src/runtime.spec.ts`}".`,
    `npm package must not include test cargo "${String.raw`dist\extensions\fixture-plugin\node_modules\direct\__tests__\index.js`}".`,
  ]);
});

it.each([
  ["2026.3.40", "v2026.3.40"],
  ["2026.3.10", "v2026.3.10-1"],
  ["2026.3.10-1", "v2026.3.10-1"],
])("accepts package %s with release tag %s", (packageVersion, releaseTag) => {
  expect(collectReleaseTagErrors({ packageVersion, releaseTag })).toStrictEqual([]);
});

it("rejects beta package versions paired with fallback correction tags", () => {
  expect(
    collectReleaseTagErrors({ packageVersion: "2026.3.10-beta.1", releaseTag: "v2026.3.10-1" }),
  ).toStrictEqual([
    "Release tag v2026.3.10-1 does not match package.json version 2026.3.10-beta.1; expected v2026.3.10-beta.1.",
  ]);
});

it("rejects local fs-safe dependency specs for npm release", () => {
  expect(
    collectReleasePackageMetadataErrors({
      name: "openclaw",
      description: "Multi-channel AI gateway with extensible messaging integrations",
      license: "MIT",
      repository: { url: "git+https://github.com/openclaw/openclaw.git" },
      bin: { openclaw: "openclaw.mjs" },
      dependencies: { "@openclaw/fs-safe": "link:../fs-safe" },
    }),
  ).toContain(
    'package.json dependencies["@openclaw/fs-safe"] must use a published semver range before npm release; found "link:../fs-safe".',
  );
});
