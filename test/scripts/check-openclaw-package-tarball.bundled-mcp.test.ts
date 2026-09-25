import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { create as createTar, ReadEntry } from "tar";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { listFilesRecursively, withTarball } from "./package-tarball-fixture.js";

const require = createRequire(import.meta.url);
const CHECK_SCRIPT = resolve("scripts/check-openclaw-package-tarball.mts");
const MCP_NAME = "chrome-devtools-mcp";
const MCP_PREFIX = `node_modules/${MCP_NAME}`;
const MCP_CLI = "build/src/bin/chrome-devtools-mcp.js";
const packageJson = {
  files: ["dist"],
  dependencies: { [MCP_NAME]: "1.9.0" },
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
    timeout: 180_000,
  });
  expect(packed.status, packed.stderr).toBe(0);
  // A local override supplies real pnpm metadata without registry or host-cache access.
  writeFileSync(
    join(packageRoot, "pnpm-workspace.yaml"),
    JSON.stringify({
      packages: ["."],
      autoInstallPeers: false,
      overrides: { [MCP_NAME]: `file:${join(fixtureRoot, `${MCP_NAME}-1.9.0.tgz`)}` },
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
    timeout: 180_000,
  });
  expect(installed.status, installed.stderr || installed.stdout).toBe(0);
  expect(lstatSync(join(packageRoot, MCP_PREFIX)).isSymbolicLink()).toBe(true);
}

describe("bundled browser MCP package", () => {
  it.each(["npm", "pnpm"] as const)(
    "retains the patched runtime through %s pack and an offline install",
    (pack) => {
      const source = sourceRoot();
      withTarball(
        ["dist/index.js"],
        { "dist/index.js": "export {};\n" },
        (tarball, root) => {
          const checked = check(tarball);
          expect(checked.status, checked.stderr).toBe(0);
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
            timeout: 180_000,
          });
          expect(installed.status, installed.stderr).toBe(0);
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
              timeout: 180_000,
              env: {
                ...process.env,
                CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
                CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
              },
            },
          );
          expect(cli.status, cli.stderr).toBe(0);
          expect(cli.stdout.trim()).toBe("1.9.0");
        },
        undefined,
        {
          packageJson,
          pack,
          beforePack: installPatchedMcp,
        },
      );
    },
    60_000,
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
      manifest: { ...packageJson, dependencies: { [MCP_NAME]: "^1.9.0" } },
      error: "must be pinned to 1.9.0",
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

  describe("payload integrity", () => {
    const fixtureDirs = useAutoCleanupTempDirTracker(afterAll);
    const mutationDirs = useAutoCleanupTempDirTracker(afterEach);
    let templateTarball: string;

    beforeAll(() => {
      templateTarball = join(fixtureDirs.make("openclaw-mcp-tarball-template-"), "template.tgz");
      withTarball(
        ["dist/index.js"],
        { "dist/index.js": "export {};\n" },
        (tarball) => {
          const result = check(tarball);
          expect(result.status, result.stderr).toBe(0);
          copyFileSync(tarball, templateTarball);
        },
        undefined,
        {
          packageJson,
          pack: "npm",
          beforePack(root) {
            cpSync(sourceRoot(), join(root, MCP_PREFIX), { recursive: true, dereference: true });
          },
        },
      );
    }, 60_000);

    it.each([
      ...[
        "build/src/TextSnapshot.js",
        "build/src/McpPage.js",
        "build/src/third_party/index.js",
        "build/src/OPENCLAW_PATCH_NOTICE.md",
      ].map((file) => ({
        file,
        change: "modify",
        error: `unpatched or changed runtime entry ${file}`,
      })),
      ...[
        MCP_CLI,
        "build/src/bin/chrome-devtools-mcp-main.js",
        "build/src/third_party/devtools-formatter-worker.js",
        "build/src/third_party/devtools-heap-snapshot-worker.js",
        "build/src/third_party/lighthouse-devtools-mcp-bundle.js",
        "LICENSE",
        "build/src/third_party/THIRD_PARTY_NOTICES",
      ].map((file) => ({
        file,
        change: "remove",
        error: `missing required runtime entry ${file}`,
      })),
      {
        file: "build/src/third_party/issue-descriptions",
        change: "remove",
        error: "missing third-party issue descriptions",
      },
    ])(
      "rejects $change of bundled $file",
      ({ file, change, error }) => {
        const root = mutationDirs.make("openclaw-mcp-tarball-mutation-");
        const tarball = join(root, "openclaw.tgz");
        const target = `package/${MCP_PREFIX}/${file}`;
        if (change === "modify") {
          const replacement = join(root, target);
          mkdirSync(dirname(replacement), { recursive: true });
          writeFileSync(
            replacement,
            Buffer.concat([readFileSync(join(sourceRoot(), file)), Buffer.from("\n")]),
          );
          chmodSync(replacement, 0o644);
        }
        let removed = 0;
        // Packing inclusion is covered above; these cases corrupt independently copied payloads.
        createTar(
          {
            cwd: root,
            file: tarball,
            gzip: { level: 1 },
            sync: true,
            strict: true,
            filter(path, entry) {
              if (
                entry instanceof ReadEntry &&
                (path === target || path.startsWith(`${target}/`))
              ) {
                removed += 1;
                return false;
              }
              return true;
            },
          },
          [`@${templateTarball}`, ...(change === "modify" ? [target] : [])],
        );
        expect(removed).toBeGreaterThan(0);
        const result = check(tarball);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(error);
      },
      60_000,
    );
  });
});
