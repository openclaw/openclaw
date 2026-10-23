import { spawnSync } from "node:child_process";
import { readFileSync as readFileSyncOriginal, unlinkSync as unlinkSyncOriginal } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsdown";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import {
  completePackageLifecycle,
  isSourceCheckoutRoot,
  isDirectPostinstallInvocation,
  MAX_INSTALLED_DIST_SCAN_ENTRIES,
  pruneInstalledPackageDist,
  runBundledPluginPostinstall,
} from "../../scripts/postinstall-bundled-plugins.mjs";
import { createSourcePluginDependenciesFixture } from "./source-plugin-dependencies-fixture.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDirAsync } = createScriptTestHarness();
const quietLog = () => ({ log: vi.fn(), warn: vi.fn() });
function prune(
  packageRoot: string,
  expected: string[],
  options: Parameters<typeof pruneInstalledPackageDist>[0] = {},
) {
  return pruneInstalledPackageDist({
    packageRoot,
    expectedFiles: new Set(expected),
    log: quietLog(),
    ...options,
  });
}
async function writeFiles(
  root: string,
  files: Record<string, string> | string[],
  contents = "{}\n",
) {
  const entries = Array.isArray(files)
    ? files.map((file): [string, string] => [file, contents])
    : Object.entries(files);
  for (const [relative, content] of entries) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}
async function seedDist(
  root: string,
  current: Record<string, string>,
  stale: Record<string, string> = {},
) {
  await writeFiles(path.join(root, "dist"), current);
  await writePackageDistInventory(root);
  await writeFiles(path.join(root, "dist"), stale);
}
function runPostinstall(packageRoot: string, env: NodeJS.ProcessEnv = {}, windows = false) {
  const home = path.join(packageRoot, "home");
  const script = path.join(packageRoot, "scripts/postinstall-bundled-plugins.mjs");
  const args = windows
    ? [
        "--input-type=module",
        "--eval",
        `Object.defineProperty(process, "platform", { value: "win32" });
process.argv[1] = ${JSON.stringify(script)};
await import(${JSON.stringify(pathToFileURL(script).href)});`,
      ]
    : [script];
  return spawnSync(process.execPath, args, {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: windows ? 10_000 : undefined,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: path.join(packageRoot, "state"),
      OPENCLAW_CONFIG_PATH: undefined,
      STATE_DIRECTORY: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: undefined,
      ...env,
    },
  });
}

async function makePackage(files: string[] = []) {
  const packageRoot = await createTempDirAsync("postinstall-");
  const at = (...parts: string[]) => path.join(packageRoot, ...parts);
  await writeFiles(at("dist"), Object.fromEntries(files.map((file) => [file, "keep\n"])));
  return { packageRoot, at };
}

async function copyPostinstallFixture(packageRoot: string) {
  for (const relativePath of [
    "scripts/postinstall-bundled-plugins.mjs",
    "scripts/lib/package-lifecycle-marker.mjs",
    "scripts/lib/fs-safe-prebuild.mjs",
    "scripts/windows-cmd-helpers.mjs",
  ]) {
    const destination = path.join(packageRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(
      fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
      destination,
    );
  }
}

async function expectPathExists(...paths: string[]) {
  for (const filePath of paths) {
    await fs.access(filePath);
  }
}

async function expectPathMissing(...paths: string[]) {
  for (const filePath of paths) {
    await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
  }
}

describe("bundled plugin postinstall", () => {
  it("compiles source without consuming an installed runtime artifact", async () => {
    const { packageRoot, at } = await makePackage();
    await copyPostinstallFixture(packageRoot);
    const installedGuard = at("dist/commands/doctor-update-schema-guard.js");
    await writeFiles(packageRoot, {
      "dist/commands/doctor-update-schema-guard.js":
        "export async function preflightUpdatePackageLifecycle() {}\n",
    });
    const { bundles } = await build({
      config: false,
      cwd: packageRoot,
      root: packageRoot,
      entry: ["scripts/postinstall-bundled-plugins.mjs"],
      outDir: at("compiled"),
      unbundle: true,
      treeshake: false,
      dts: false,
      logLevel: "silent",
    });
    try {
      const inputs = bundles.flatMap(({ chunks }) =>
        chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : [])),
      );
      expect(inputs).toContain(at("scripts/postinstall-bundled-plugins.mjs"));
      expect(inputs).not.toContain(installedGuard);
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });

  it("preserves lifecycle completion policy for marked Windows updates", async () => {
    const { packageRoot, at } = await makePackage();
    await copyPostinstallFixture(packageRoot);
    await writeFiles(packageRoot, {
      "package.json": '{"type":"module"}\n',
      "dist/commands/doctor-update-schema-guard.js":
        'export async function preflightUpdatePackageLifecycle() { throw new Error("fixture: previous Gateway data must remain readable"); }\n',
    });
    const pending = at(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
    await fs.writeFile(pending, "pending\n");
    const result = runPostinstall(
      packageRoot,
      { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1" },
      true,
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("fixture: previous Gateway data must remain readable");
    expect(await fs.readFile(pending, "utf8")).toBe("pending\n");
  });

  it("recognizes direct invocation through symlinked temp prefixes", () => {
    const realpathSync = vi.fn((value: string) =>
      value.replace(/^\/var\/folders\//u, "/private/var/folders/"),
    );

    expect(
      isDirectPostinstallInvocation({
        entryPath: "/var/folders/tmp/openclaw/scripts/postinstall-bundled-plugins.mjs",
        modulePath: "/private/var/folders/tmp/openclaw/scripts/postinstall-bundled-plugins.mjs",
        realpathSync,
      }),
    ).toBe(true);
  });

  it("fails lifecycle completion when its marker cannot be removed", () => {
    const reportError = vi.fn();

    expect(
      completePackageLifecycle(
        {
          packageRoot: "/pkg",
          rmSync: () => {
            throw new Error("read-only package");
          },
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("could not complete package lifecycle: Error: read-only package"),
    );
  });

  it("preserves shared default and configured Node caches during packaged postinstall", async () => {
    const { packageRoot, at } = await makePackage();
    const temporaryRoot = at("temporary");
    const configuredCacheRoot = at("configured-node-cache");
    const defaultCacheRoot = path.join(temporaryRoot, "node-compile-cache");
    const sentinels = [
      path.join(defaultCacheRoot, "v22.22.3-x64-another-app", "keep.txt"),
      path.join(defaultCacheRoot, "v24.15.0-x64-other-install", "keep.txt"),
      path.join(configuredCacheRoot, "v25.9.0-x64-another-app", "keep.txt"),
      path.join(configuredCacheRoot, "v26.4.0-x64-other-install", "keep.txt"),
    ];

    await copyPostinstallFixture(packageRoot);
    await fs.mkdir(at("home"), { recursive: true });
    await fs.writeFile(
      at("package.json"),
      '{"name":"openclaw","type":"module","version":"2026.7.2"}\n',
    );
    await writeFiles(
      packageRoot,
      sentinels.map((file) => path.relative(packageRoot, file)),
      "owned by another Node application\n",
    );

    const result = runPostinstall(packageRoot, {
      NODE_COMPILE_CACHE: configuredCacheRoot,
      NODE_DISABLE_COMPILE_CACHE: undefined,
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
      TMPDIR: temporaryRoot,
    });

    expect(result.status, result.stderr).toBe(0);
    await expectPathExists(...sentinels);
  });

  it("does not classify published packages with source files as source checkouts", () => {
    const existingPaths = new Set(
      ["pnpm-workspace.yaml", "src", "extensions", "dist/postinstall-inventory.json"].map((file) =>
        path.join("/pkg", file),
      ),
    );

    expect(
      isSourceCheckoutRoot({
        packageRoot: "/pkg",
        existsSync: (value: string) => existingPaths.has(value),
      }),
    ).toBe(false);
  });

  it.each(["workspace snapshot", "git checkout"])(
    "preserves source dependencies and state during %s postinstall",
    async (kind) => {
      const { packageRoot, at } = await makePackage();
      const fixture = await createSourcePluginDependenciesFixture(packageRoot);
      if (kind === "git checkout") {
        await fs.mkdir(at(".git"));
      }
      const legacyRuntimeRoot = at("home/.openclaw/plugin-runtime-deps");
      await writeFiles(legacyRuntimeRoot, { "package.json": "{}\n" });
      await copyPostinstallFixture(packageRoot);
      fixture.assertResolution();
      const result = runPostinstall(packageRoot, { OPENCLAW_STATE_DIR: at("home/.openclaw") });
      expect(result.status, result.stderr).toBe(0);
      fixture.assertResolution();
      await fs.access(legacyRuntimeRoot);
    },
  );

  it("honors the disable env before packaged cleanup", async () => {
    const { packageRoot, at } = await makePackage();
    await writeFiles(packageRoot, {
      "dist/postinstall-inventory.json": "[]\n",
      "dist/stale.js": "export {};\n",
    });

    runBundledPluginPostinstall({
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1" },
      packageRoot,
    });

    await expectPathExists(at("dist/stale.js"));
  });

  it("completes packaged lifecycle without changing operator databases", async () => {
    const fixtureRoot = await createTempDirAsync("openclaw-postinstall-state-");
    const packageRoot = path.join(fixtureRoot, "node_modules", "openclaw");
    const at = (...parts: string[]) => path.join(packageRoot, ...parts);
    const home = path.join(fixtureRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const markerPath = at(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
    const migrationPath = at("dist/commands/doctor/shared/plugin-registry-migration.js");
    await copyPostinstallFixture(packageRoot);
    await fs.mkdir(path.dirname(migrationPath), { recursive: true });
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(at("package.json"), '{"type":"module"}\n');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA user_version = 5; CREATE TABLE operator_state (value TEXT);");
      database.prepare("INSERT INTO operator_state VALUES (?)").run("preserve me");
    } finally {
      database.close();
    }
    const before = await fs.readFile(databasePath);
    await fs.writeFile(
      migrationPath,
      [
        "import { DatabaseSync } from 'node:sqlite';",
        "import { join } from 'node:path';",
        "export function migratePluginRegistryForInstall({ env }) {",
        "  const db = new DatabaseSync(join(env.OPENCLAW_STATE_DIR, 'state', 'openclaw.sqlite'));",
        "  try { db.exec('PRAGMA user_version = 9; DROP TABLE operator_state;'); }",
        "  finally { db.close(); }",
        "  return { migrated: true, current: { plugins: [] } };",
        "}",
      ].join("\n"),
    );
    await writePackageDistInventory(packageRoot);
    await fs.writeFile(markerPath, "pending\n");
    const result = runPostinstall(packageRoot, {
      HOME: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
    });
    expect(result.status, result.stderr).toBe(0);
    await expectPathMissing(markerPath);
    expect(await fs.readFile(databasePath)).toEqual(before);
  });

  it("prunes from the authoritative inventory without reading dist JavaScript", async () => {
    const { packageRoot, at } = await makePackage();
    const inventoryPath = at("dist", "postinstall-inventory.json");
    await seedDist(packageRoot, { "current.js": "export {};\n" }, { "stale.js": "export {};\n" });
    const readFileSync = vi.fn((filePath: string | Buffer | URL, options?: BufferEncoding) => {
      if (String(filePath) !== inventoryPath) {
        throw new Error(`unexpected dist JavaScript read: ${String(filePath)}`);
      }
      return readFileSyncOriginal(filePath, { encoding: options });
    });

    expect(pruneInstalledPackageDist({ packageRoot, readFileSync, log: quietLog() })).toEqual([
      "dist/stale.js",
    ]);

    await expectPathExists(at("dist/current.js"));
    await expectPathMissing(at("dist/stale.js"));
    expect(readFileSync).toHaveBeenCalledOnce();
    expect(readFileSync).toHaveBeenCalledWith(inventoryPath, "utf8");
  });

  it("preserves other installs' runtime dependencies and sibling symlinks during packaged postinstall", async () => {
    const prefix = await createTempDirAsync("openclaw-packaged-prefix-");
    const packageRoot = path.join(prefix, "lib", "node_modules", "openclaw");
    const nodeModulesRoot = path.dirname(packageRoot);
    const home = await createTempDirAsync("openclaw-packaged-home-");
    const stateOverride = path.join(home, "custom-state");
    const systemState = path.join(home, "system-state");
    const retainedRoots = [
      ".openclaw/plugin-runtime-deps",
      ".clawdbot/plugin-runtime-deps",
      "custom-state/plugin-runtime-deps",
      "system-state/plugin-runtime-deps",
      ".openclaw/extensions/lossless-claw/node_modules",
    ].map((relative) => path.join(home, relative));
    const legacySymlinkTarget = path.join(
      home,
      ".openclaw/plugin-runtime-deps/openclaw-2026.4.29-slack/node_modules/@slack/web-api",
    );
    const slackScope = path.join(nodeModulesRoot, "@slack");
    const legacySymlink = path.join(slackScope, "web-api");

    await seedDist(packageRoot, { "entry.js": "export {};\n" });
    for (const root of retainedRoots) {
      await writeFiles(root, ["package.json"]);
    }
    await fs.mkdir(legacySymlinkTarget, { recursive: true });
    await fs.mkdir(slackScope, { recursive: true });
    await fs.symlink(legacySymlinkTarget, legacySymlink, "dir");

    const log = quietLog();
    runBundledPluginPostinstall({
      env: { HOME: home, OPENCLAW_STATE_DIR: stateOverride, STATE_DIRECTORY: systemState },
      packageRoot,
      log,
    });

    await expectPathExists(...retainedRoots, legacySymlink);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.log).not.toHaveBeenCalled();
  });

  it("prunes stale private QA files without restoring compat sidecars", async () => {
    const { packageRoot, at } = await makePackage();
    await seedDist(
      packageRoot,
      {
        "entry.js": "export {};\n",
        "extensions/example/openclaw.plugin.json": "{}\n",
      },
      {
        "extensions/qa-lab/package.json": "{}\n",
        "extensions/qa-lab/openclaw.plugin.json": "{}\n",
      },
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(at("dist", "postinstall-inventory.json"))).mode & 0o777).toBe(0o644);
    }

    runBundledPluginPostinstall({ packageRoot, log: quietLog() });

    await expectPathExists(at("dist/extensions/example/openclaw.plugin.json"));
    await expectPathMissing(
      ...[
        "qa-lab/package.json",
        "qa-lab/openclaw.plugin.json",
        "qa-channel/runtime-api.js",
        "qa-channel/package.json",
        "qa-channel/openclaw.plugin.json",
        "qa-lab/runtime-api.js",
      ].map((relative) => at("dist/extensions", relative)),
    );
  });

  it.each(["missing", "invalid"])(
    "keeps packaged postinstall non-fatal for %s inventory",
    async (kind) => {
      const { packageRoot, at } = await makePackage(["stale.js"]);
      if (kind === "invalid") {
        await fs.writeFile(at("dist/postinstall-inventory.json"), "{not-json}\n");
      }
      const log = quietLog();
      expect(runBundledPluginPostinstall({ packageRoot, log })).toBeUndefined();
      await expectPathExists(at("dist/stale.js"));
      expect(log.warn).toHaveBeenCalledWith(
        `[postinstall] skipping dist prune: ${kind} dist inventory: dist/postinstall-inventory.json`,
      );
    },
  );

  it.each(["root", "entry"])("rejects symlinked dist %s in packaged installs", async (kind) => {
    const { packageRoot, at } = await makePackage(kind === "entry" ? ["kept.js"] : []);
    const targetDir = await createTempDirAsync("openclaw-postinstall-symlink-target-");
    const sentinel = path.join(targetDir, "sentinel.js");
    await fs.writeFile(sentinel, "outside data\n");
    const link = at("dist", ...(kind === "entry" ? ["escape"] : []));
    // Directory junctions require no Windows symlink privilege.
    await fs.symlink(targetDir, link, "junction");

    expect(() => pruneInstalledPackageDist({ packageRoot, expectedFiles: new Set() })).toThrow(
      kind === "root"
        ? "unsafe dist root: dist must be a real directory"
        : "unsafe dist entry: dist/escape",
    );
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(sentinel, "utf8")).toBe("outside data\n");
    if (kind === "entry") {
      expect(await fs.readFile(at("dist/kept.js"), "utf8")).toBe("keep\n");
    }
  });

  it.each([
    ["shared listing and pruning", "kept.js", ["dist/kept.js"]],
    ["legacy dependency prepass", "extensions/slack/node_modules/sentinel.js", []],
  ] as const)("bounds the %s with one packaged dist scan budget", async (_phase, file, kept) => {
    const { packageRoot, at } = await makePackage([file]);
    expect(() =>
      pruneInstalledPackageDist({
        packageRoot,
        expectedFiles: new Set(kept),
        maxDistScanEntries: 1,
      }),
    ).toThrow(
      "installed dist scan exceeded 1 filesystem entries; refusing to scan unbounded package contents",
    );
    expect(await fs.readFile(at("dist", file), "utf8")).toBe("keep\n");
    // npm upgrades hold old+new content-hashed output; retain several-times headroom.
    expect(MAX_INSTALLED_DIST_SCAN_ENTRIES).toBeGreaterThanOrEqual(100_000);
  });

  it("idempotently prunes stale dependency debris and sibling empty dist directories", async () => {
    const { packageRoot, at } = await makePackage();
    const slackRoot = at("dist/extensions/slack");
    const binDir = path.join(slackRoot, "node_modules/.bin");
    const installStage = ".openclaw-install-stage/node_modules/typebox/build/compile/code.mjs";
    const retryStage = ".openclaw-install-stage-retry/node_modules/typebox/build/compile/code.mjs";
    await writeFiles(packageRoot, { "dist/stale-runtime.js": "export {};\n" });
    await writeFiles(slackRoot, {
      "package.json": "{}\n",
      "node_modules/typebox/package.json": "{}\n",
      [installStage]: "export {};\n",
      [retryStage]: "export {};\n",
    });
    await fs.mkdir(binDir, { recursive: true });
    await fs.symlink("../fxparser/bin.js", path.join(binDir, "fxparser"));
    const emptyDirs = [at("dist/empty-a"), at("dist/empty-b")];
    for (const directory of emptyDirs) {
      await fs.mkdir(directory);
    }

    expect(prune(packageRoot, ["dist/extensions/slack/package.json"])).toEqual([
      "dist/stale-runtime.js",
    ]);
    await expectPathMissing(
      path.join(slackRoot, "node_modules"),
      path.dirname(path.join(slackRoot, installStage)),
      path.dirname(path.join(slackRoot, retryStage)),
      ...emptyDirs,
    );
    expect(prune(packageRoot, ["dist/extensions/slack/package.json"])).toEqual([]);
  });

  it("unlinks stale files instead of recursive pruning them", async () => {
    const { packageRoot, at } = await makePackage(["stale.js"]);
    const unlinkSync = vi.fn(unlinkSyncOriginal);
    expect(prune(packageRoot, [], { unlinkSync })).toEqual(["dist/stale.js"]);
    expect(unlinkSync).toHaveBeenCalledWith(at("dist", "stale.js"));
    await expectPathMissing(at("dist", "stale.js"));
  });
});
