import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import {
  expectPackageCommandSuccess,
  listFilesRecursively,
  withTarball,
} from "./package-tarball-fixture.js";

const require = createRequire(import.meta.url);
const CHECK_SCRIPT = resolve("scripts/check-openclaw-package-tarball.mts");
const MCP_NAME = "chrome-devtools-mcp";
const MCP_PREFIX = `node_modules/${MCP_NAME}`;
const MCP_CLI = "build/src/bin/chrome-devtools-mcp.js";
const MCP_PROCESS_TIMEOUT_MS = 180_000;
// The real ~90 MiB offline install has a three-minute subprocess budget on Windows.
// Allow fixture packing, byte comparisons, and cleanup before Vitest rejects a completed run.
const MCP_PACKAGE_TEST_TIMEOUT_MS = MCP_PROCESS_TIMEOUT_MS + 60_000;
const packageJson = {
  files: ["dist"],
  dependencies: { [MCP_NAME]: "1.10.1" },
  bundleDependencies: [MCP_NAME],
};

function check(tarball: string) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, tarball], { encoding: "utf8" });
}

function packageBytes(root: string) {
  return Object.fromEntries(
    listFilesRecursively(root)
      // Package-manager bin wrappers are not part of the published MCP payload.
      .filter((file) => !file.replaceAll("\\", "/").startsWith("node_modules/"))
      .toSorted()
      .map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(root, file)))
          .digest("hex"),
      ]),
  );
}

function sourceRoot() {
  return dirname(require.resolve(`${MCP_NAME}/package.json`));
}

function installPatchedMcp(packageRoot: string) {
  const fixtureRoot = dirname(packageRoot);
  const npm = resolveNpmRunner({
    npmArgs: ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", fixtureRoot],
  });
  const packed = spawnSync(npm.command, npm.args, {
    cwd: sourceRoot(),
    encoding: "utf8",
    env: npm.env,
    shell: npm.shell,
    windowsVerbatimArguments: npm.windowsVerbatimArguments,
    timeout: MCP_PROCESS_TIMEOUT_MS,
  });
  expectPackageCommandSuccess(packed, "pack installed browser MCP");
  // A local override supplies real pnpm metadata without registry or host-cache access.
  writeFileSync(
    join(packageRoot, "pnpm-workspace.yaml"),
    JSON.stringify({
      packages: ["."],
      autoInstallPeers: false,
      overrides: { [MCP_NAME]: `file:${join(fixtureRoot, `${MCP_NAME}-1.10.1.tgz`)}` },
    }),
  );
  const pnpm = resolvePnpmRunner({
    cwd: packageRoot,
    pnpmArgs: [
      "install",
      "--offline",
      "--no-frozen-lockfile",
      "--ignore-scripts",
      "--package-import-method=copy",
      "--store-dir",
      join(fixtureRoot, "store"),
    ],
  });
  const installed = spawnSync(pnpm.command, pnpm.args, {
    cwd: packageRoot,
    encoding: "utf8",
    shell: pnpm.shell,
    windowsVerbatimArguments: pnpm.windowsVerbatimArguments,
    timeout: MCP_PROCESS_TIMEOUT_MS,
  });
  expectPackageCommandSuccess(installed, "install browser MCP fixture");
  expect(lstatSync(join(packageRoot, MCP_PREFIX)).isSymbolicLink()).toBe(true);
}

describe("bundled browser MCP package", () => {
  it("retains native spawn failure facts and cleans the pre-pack fixture", () => {
    let root = "";
    let bodyRan = false;
    expect(() =>
      withTarball(
        [],
        {},
        () => {
          bodyRan = true;
        },
        undefined,
        {
          beforePack(packageRoot) {
            root = dirname(packageRoot);
            const result = spawnSync(join(packageRoot, "missing-command"), [], {
              encoding: "utf8",
            });
            expectPackageCommandSuccess(result, "missing fixture command");
          },
        },
      ),
    ).toThrowError(/"status":null,"signal":null,.*"code":"ENOENT"/);
    expect(bodyRan).toBe(false);
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });

  it("keeps both streams alongside native errors without changing exit assertions", () => {
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
    expect(() => expectPackageCommandSuccess(result, "successful command")).not.toThrow();
    const failed = spawnSync(process.execPath, ["-e", "process.exit(7)"], { encoding: "utf8" });
    expect(() => expectPackageCommandSuccess(failed, "failed command")).toThrowError(/"status":7/);
    expect(() =>
      expectPackageCommandSuccess(
        {
          ...result,
          status: null,
          signal: "SIGTERM",
          error: Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" }),
          stderr: "captured stderr",
          stdout: "captured stdout",
        },
        "fixture pack",
      ),
    ).toThrowError(
      /fixture pack[\s\S]*"signal":"SIGTERM"[\s\S]*"code":"ETIMEDOUT"[\s\S]*spawn timed out[\s\S]*captured stderr[\s\S]*captured stdout/,
    );
  });

  it.each(["npm", "pnpm"] as const)(
    "retains the patched runtime through %s pack and an offline install",
    (pack) => {
      const source = sourceRoot();
      withTarball(
        ["dist/index.js"],
        { "dist/index.js": "export {};\n" },
        (tarball, root) => {
          const checked = check(tarball);
          expectPackageCommandSuccess(checked, "check bundled browser MCP tarball");
          const consumer = join(root, "consumer");
          mkdirSync(consumer);
          writeFileSync(
            join(consumer, "package.json"),
            '{"name":"browser-bundle-consumer","private":true}',
          );
          const npm = resolveNpmRunner({
            npmArgs: [
              "install",
              "--offline",
              "--ignore-scripts",
              "--omit=dev",
              "--omit=peer",
              "--legacy-peer-deps",
              "--no-audit",
              "--no-fund",
              tarball,
            ],
          });
          const installed = spawnSync(npm.command, npm.args, {
            cwd: consumer,
            encoding: "utf8",
            env: npm.env,
            shell: npm.shell,
            windowsVerbatimArguments: npm.windowsVerbatimArguments,
            timeout: MCP_PROCESS_TIMEOUT_MS,
          });
          expectPackageCommandSuccess(installed, "install bundled browser MCP consumer");
          const consumerRequire = createRequire(
            join(consumer, "node_modules/openclaw/package.json"),
          );
          const installedRoot = dirname(consumerRequire.resolve(`${MCP_NAME}/package.json`));
          expect(packageBytes(installedRoot)).toEqual(packageBytes(source));
          const cli = spawnSync(
            process.execPath,
            [consumerRequire.resolve(`${MCP_NAME}/${MCP_CLI}`), "--version"],
            {
              cwd: consumer,
              encoding: "utf8",
              timeout: MCP_PROCESS_TIMEOUT_MS,
              env: {
                ...process.env,
                CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
                CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
              },
            },
          );
          expectPackageCommandSuccess(cli, "read bundled browser MCP version");
          expect(cli.stdout.trim()).toBe("1.10.1");
        },
        undefined,
        {
          packageJson,
          pack,
          beforePack: installPatchedMcp,
        },
      );
    },
    MCP_PACKAGE_TEST_TIMEOUT_MS,
  );

  it.each([
    {
      name: "missing bundle declaration",
      manifest: { dependencies: packageJson.dependencies },
      error: "must be listed in bundleDependencies",
    },
    {
      name: "missing declared payload",
      manifest: packageJson,
      error: `must be bundled in ${MCP_PREFIX}`,
    },
    {
      name: "unpinned dependency",
      manifest: { ...packageJson, dependencies: { [MCP_NAME]: "^1.10.1" } },
      error: "must be pinned to a supported patched version",
    },
    {
      name: "bundle without a dependency pin",
      manifest: { bundleDependencies: [MCP_NAME] },
      error: "must be pinned to a supported patched version",
    },
    {
      name: "missing generic declared bundle",
      manifest: { dependencies: { example: "1.0.0" }, bundleDependencies: ["example"] },
      error: "must be bundled in node_modules/example",
    },
  ])("rejects $name in ordinary mode", ({ manifest, error }) => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = check(tarball);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(error);
      },
      undefined,
      { packageJson: manifest },
    );
  });

  it("rejects changed runtime bytes in the packed artifact", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = check(tarball);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "unpatched or changed runtime entry build/src/TextSnapshot.js",
        );
      },
      undefined,
      {
        packageJson,
        pack: "npm",
        beforePack(root) {
          const bundled = join(root, MCP_PREFIX);
          cpSync(sourceRoot(), bundled, { recursive: true, dereference: true });
          const target = join(bundled, "build/src/TextSnapshot.js");
          writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("\n")]));
        },
      },
    );
  }, 60_000);
});
