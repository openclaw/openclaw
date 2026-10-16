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
async function writeFiles(root: string, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}
function runPostinstall(packageRoot: string, env: NodeJS.ProcessEnv = {}) {
  const home = path.join(packageRoot, "home");
  return spawnSync(
    process.execPath,
    [path.join(packageRoot, "scripts/postinstall-bundled-plugins.mjs")],
    {
      cwd: packageRoot,
      encoding: "utf8",
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
    },
  );
}

async function createInstalledDistFixture(files: string[]) {
  const packageRoot = await createTempDirAsync("openclaw-installed-dist-");
  await writeFiles(
    path.join(packageRoot, "dist"),
    Object.fromEntries(files.map((file) => [file, "keep\n"])),
  );
  return packageRoot;
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

async function expectPathExists(filePath: string) {
  await fs.access(filePath);
}

async function expectPathMissing(filePath: string) {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

describe("bundled plugin postinstall", () => {
  it("compiles source without consuming an installed runtime artifact", async () => {
    const packageRoot = await createTempDirAsync("openclaw-postinstall-source-build-");
    await copyPostinstallFixture(packageRoot);
    const installedGuard = path.join(packageRoot, "dist/commands/doctor-update-schema-guard.js");
    await fs.mkdir(path.dirname(installedGuard), { recursive: true });
    await fs.writeFile(
      installedGuard,
      "export async function preflightUpdatePackageLifecycle() {}\n",
    );
    const { bundles } = await build({
      config: false,
      cwd: packageRoot,
      root: packageRoot,
      entry: ["scripts/postinstall-bundled-plugins.mjs"],
      outDir: path.join(packageRoot, "compiled"),
      unbundle: true,
      treeshake: false,
      dts: false,
      logLevel: "silent",
    });
    try {
      const inputs = bundles.flatMap(({ chunks }) =>
        chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : [])),
      );
      expect(inputs).toContain(path.join(packageRoot, "scripts/postinstall-bundled-plugins.mjs"));
      expect(inputs).not.toContain(installedGuard);
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });

  it("preserves lifecycle completion policy for marked Windows updates", async () => {
    const packageRoot = await createTempDirAsync("openclaw-update-postinstall-");
    await copyPostinstallFixture(packageRoot);
    await writeFiles(packageRoot, {
      "package.json": '{"type":"module"}\n',
      "dist/commands/doctor-update-schema-guard.js":
        'export async function preflightUpdatePackageLifecycle() { throw new Error("fixture: previous Gateway data must remain readable"); }\n',
    });
    const pending = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
    await fs.writeFile(pending, "pending\n");
    const script = path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `Object.defineProperty(process, "platform", { value: "win32" });
process.argv[1] = ${JSON.stringify(script)};
await import(${JSON.stringify(pathToFileURL(script).href)});`,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1",
        },
      },
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
    const packageRoot = await createTempDirAsync("openclaw-packaged-compile-cache-");
    const temporaryRoot = path.join(packageRoot, "temporary");
    const configuredCacheRoot = path.join(packageRoot, "configured-node-cache");
    const defaultCacheRoot = path.join(temporaryRoot, "node-compile-cache");
    const sentinels = [
      path.join(defaultCacheRoot, "v22.22.3-x64-another-app", "keep.txt"),
      path.join(defaultCacheRoot, "v24.15.0-x64-other-install", "keep.txt"),
      path.join(configuredCacheRoot, "v25.9.0-x64-another-app", "keep.txt"),
      path.join(configuredCacheRoot, "v26.4.0-x64-other-install", "keep.txt"),
    ];

    await copyPostinstallFixture(packageRoot);
    await fs.mkdir(path.join(packageRoot, "home"), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"openclaw","type":"module","version":"2026.7.2"}\n',
    );
    for (const sentinel of sentinels) {
      await fs.mkdir(path.dirname(sentinel), { recursive: true });
      await fs.writeFile(sentinel, "owned by another Node application\n");
    }

    const result = runPostinstall(packageRoot, {
      NODE_COMPILE_CACHE: configuredCacheRoot,
      NODE_DISABLE_COMPILE_CACHE: undefined,
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
      TMPDIR: temporaryRoot,
    });

    expect(result.status, result.stderr).toBe(0);
    for (const sentinel of sentinels) {
      await expectPathExists(sentinel);
    }
  });

  it("does not classify published packages with source files as source checkouts", () => {
    const packageRoot = "/pkg";
    const existingPaths = new Set([
      path.join(packageRoot, "package.json"),
      path.join(packageRoot, "pnpm-workspace.yaml"),
      path.join(packageRoot, "src"),
      path.join(packageRoot, "extensions"),
      path.join(packageRoot, "dist", "postinstall-inventory.json"),
    ]);

    expect(
      isSourceCheckoutRoot({
        packageRoot,
        existsSync: (value: string) => existingPaths.has(value),
      }),
    ).toBe(false);
  });

  it("preserves importer dependency resolution during workspace snapshot postinstall", async () => {
    const packageRoot = await createTempDirAsync("openclaw-source-resolution-");
    const fixture = await createSourcePluginDependenciesFixture(packageRoot);
    await copyPostinstallFixture(packageRoot);
    fixture.assertResolution();
    const result = runPostinstall(packageRoot);
    expect(result.status, result.stderr).toBe(0);
    fixture.assertResolution();
  });

  it("does not prune user-state legacy runtime deps during source-checkout postinstall", async () => {
    const packageRoot = await createTempDirAsync("openclaw-source-checkout-state-skip-");
    const home = await createTempDirAsync("openclaw-source-checkout-home-");
    const legacyRuntimeRoot = path.join(home, ".openclaw", "plugin-runtime-deps");
    await fs.mkdir(path.join(packageRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(packageRoot, "extensions"), { recursive: true });
    await fs.mkdir(legacyRuntimeRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRuntimeRoot, "package.json"), "{}\n");

    runBundledPluginPostinstall({
      env: { HOME: home },
      packageRoot,
      log: quietLog(),
    });

    await expectPathExists(legacyRuntimeRoot);
  });

  it("honors the disable env before packaged cleanup", async () => {
    const packageRoot = await createTempDirAsync("openclaw-postinstall-disabled-");
    const staleFile = path.join(packageRoot, "dist", "stale.js");
    await writeFiles(packageRoot, {
      "dist/postinstall-inventory.json": "[]\n",
      "dist/stale.js": "export {};\n",
    });

    runBundledPluginPostinstall({
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1" },
      packageRoot,
    });

    await expectPathExists(staleFile);
  });

  it("completes packaged lifecycle without changing operator databases", async () => {
    const fixtureRoot = await createTempDirAsync("openclaw-postinstall-state-");
    const packageRoot = path.join(fixtureRoot, "node_modules", "openclaw");
    const home = path.join(fixtureRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
    const migrationPath = path.join(
      packageRoot,
      "dist/commands/doctor/shared/plugin-registry-migration.js",
    );
    await copyPostinstallFixture(packageRoot);
    await fs.mkdir(path.dirname(migrationPath), { recursive: true });
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"type":"module"}\n');
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
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-no-js-read-");
    const currentFile = path.join(packageRoot, "dist", "current.js");
    const staleFile = path.join(packageRoot, "dist", "stale.js");
    const inventoryPath = path.join(packageRoot, "dist", "postinstall-inventory.json");
    await fs.mkdir(path.dirname(currentFile), { recursive: true });
    await fs.writeFile(currentFile, "export {};\n");
    await writePackageDistInventory(packageRoot);
    await fs.writeFile(staleFile, "export {};\n");
    const readFileSync = vi.fn((filePath: string | Buffer | URL, options?: BufferEncoding) => {
      if (String(filePath) !== inventoryPath) {
        throw new Error(`unexpected dist JavaScript read: ${String(filePath)}`);
      }
      return readFileSyncOriginal(filePath, { encoding: options });
    });

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        readFileSync,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/stale.js"]);

    await expectPathExists(currentFile);
    await expectPathMissing(staleFile);
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
    const defaultLegacyRoot = path.join(home, ".openclaw", "plugin-runtime-deps");
    const oldBrandLegacyRoot = path.join(home, ".clawdbot", "plugin-runtime-deps");
    const overrideLegacyRoot = path.join(stateOverride, "plugin-runtime-deps");
    const systemLegacyRoot = path.join(systemState, "plugin-runtime-deps");
    const thirdPartyNodeModules = path.join(
      home,
      ".openclaw/extensions/lossless-claw/node_modules",
    );
    const currentFile = path.join(packageRoot, "dist", "entry.js");
    const legacySymlinkTarget = path.join(
      defaultLegacyRoot,
      "openclaw-2026.4.29-slack/node_modules/@slack/web-api",
    );
    const slackScope = path.join(nodeModulesRoot, "@slack");
    const legacySymlink = path.join(slackScope, "web-api");

    await fs.mkdir(path.dirname(currentFile), { recursive: true });
    await fs.writeFile(currentFile, "export {};\n");
    await writePackageDistInventory(packageRoot);
    for (const root of [
      defaultLegacyRoot,
      oldBrandLegacyRoot,
      overrideLegacyRoot,
      systemLegacyRoot,
      thirdPartyNodeModules,
    ]) {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), "{}\n");
    }
    await fs.mkdir(legacySymlinkTarget, { recursive: true });
    await fs.mkdir(slackScope, { recursive: true });
    await fs.symlink(legacySymlinkTarget, legacySymlink, "dir");

    const log = { log: vi.fn(), warn: vi.fn() };
    runBundledPluginPostinstall({
      env: {
        HOME: home,
        OPENCLAW_STATE_DIR: stateOverride,
        STATE_DIRECTORY: systemState,
      },
      packageRoot,
      log,
    });

    await expectPathExists(defaultLegacyRoot);
    await expectPathExists(oldBrandLegacyRoot);
    await expectPathExists(overrideLegacyRoot);
    await expectPathExists(systemLegacyRoot);
    await expectPathExists(legacySymlink);
    await expectPathExists(thirdPartyNodeModules);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.log).not.toHaveBeenCalled();
  });

  it("prunes stale private QA files without restoring compat sidecars", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-qa-compat-");
    const currentFile = path.join(packageRoot, "dist", "entry.js");
    const currentManifest = path.join(packageRoot, "dist/extensions/example/openclaw.plugin.json");
    const stalePackage = path.join(packageRoot, "dist", "extensions", "qa-lab", "package.json");
    const staleManifest = path.join(packageRoot, "dist/extensions/qa-lab/openclaw.plugin.json");
    await fs.mkdir(path.dirname(stalePackage), { recursive: true });
    await fs.mkdir(path.dirname(currentManifest), { recursive: true });
    await fs.writeFile(currentFile, "export {};\n");
    await fs.writeFile(currentManifest, "{}\n");
    await writePackageDistInventory(packageRoot);
    if (process.platform !== "win32") {
      expect(
        (await fs.stat(path.join(packageRoot, "dist", "postinstall-inventory.json"))).mode & 0o777,
      ).toBe(0o644);
    }
    await fs.writeFile(stalePackage, "{}\n");
    await fs.writeFile(staleManifest, "{}\n");

    runBundledPluginPostinstall({
      packageRoot,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await expectPathExists(currentManifest);
    await expectPathMissing(stalePackage);
    await expectPathMissing(staleManifest);
    for (const relative of [
      "qa-channel/runtime-api.js",
      "qa-channel/package.json",
      "qa-channel/openclaw.plugin.json",
      "qa-lab/runtime-api.js",
    ]) {
      await expectPathMissing(path.join(packageRoot, "dist/extensions", relative));
    }
  });

  it.each(["missing", "invalid"])(
    "keeps packaged postinstall non-fatal for %s inventory",
    async (kind) => {
      const packageRoot = await createInstalledDistFixture(["stale.js"]);
      if (kind === "invalid") {
        await fs.writeFile(
          path.join(packageRoot, "dist/postinstall-inventory.json"),
          "{not-json}\n",
        );
      }
      const log = quietLog();
      expect(runBundledPluginPostinstall({ packageRoot, log })).toBeUndefined();
      await expectPathExists(path.join(packageRoot, "dist/stale.js"));
      expect(log.warn).toHaveBeenCalledWith(
        `[postinstall] skipping dist prune: ${kind} dist inventory: dist/postinstall-inventory.json`,
      );
    },
  );

  it.each(["root", "entry"])("rejects symlinked dist %s in packaged installs", async (kind) => {
    const packageRoot = await createInstalledDistFixture(kind === "entry" ? ["kept.js"] : []);
    const targetDir = await createTempDirAsync("openclaw-postinstall-symlink-target-");
    const sentinel = path.join(targetDir, "sentinel.js");
    await fs.writeFile(sentinel, "outside data\n");
    const link = path.join(packageRoot, "dist", ...(kind === "entry" ? ["escape"] : []));
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
      expect(await fs.readFile(path.join(packageRoot, "dist/kept.js"), "utf8")).toBe("keep\n");
    }
  });

  it.each([
    { phase: "shared listing and pruning", files: ["kept.js"], kept: ["dist/kept.js"] },
    {
      phase: "legacy dependency prepass",
      files: ["extensions/slack/node_modules/sentinel.js"],
      kept: [],
    },
  ])("bounds the $phase with one packaged dist scan budget", async ({ files, kept }) => {
    const packageRoot = await createInstalledDistFixture(files);
    expect(() =>
      pruneInstalledPackageDist({
        packageRoot,
        expectedFiles: new Set(kept),
        maxDistScanEntries: 1,
      }),
    ).toThrow(
      "installed dist scan exceeded 1 filesystem entries; refusing to scan unbounded package contents",
    );
    for (const file of files) {
      expect(await fs.readFile(path.join(packageRoot, "dist", file), "utf8")).toBe("keep\n");
    }
    // npm upgrades hold old+new content-hashed output; retain several-times headroom.
    expect(MAX_INSTALLED_DIST_SCAN_ENTRIES).toBeGreaterThanOrEqual(100_000);
  });

  it("prunes sibling empty dist directories after closing parent scans", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-empty-dirs-");
    const firstEmptyDir = path.join(packageRoot, "dist", "empty-a");
    const secondEmptyDir = path.join(packageRoot, "dist", "empty-b");
    await fs.mkdir(firstEmptyDir, { recursive: true });
    await fs.mkdir(secondEmptyDir, { recursive: true });

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        expectedFiles: new Set(),
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual([]);

    await expectPathMissing(firstEmptyDir);
    await expectPathMissing(secondEmptyDir);
  });

  it("prunes stale bundled plugin dependency debris from packaged dist", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-dist-prune-");
    const slackRoot = path.join(packageRoot, "dist/extensions/slack");
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

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        expectedFiles: new Set(["dist/extensions/slack/package.json"]),
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/stale-runtime.js"]);
    await expectPathMissing(path.join(slackRoot, "node_modules"));
    await expectPathMissing(path.dirname(path.join(slackRoot, installStage)));
    await expectPathMissing(path.dirname(path.join(slackRoot, retryStage)));
  });

  it("unlinks stale files instead of recursive pruning them", async () => {
    const packageRoot = await createInstalledDistFixture(["stale.js"]);
    const unlinkSync = vi.fn(unlinkSyncOriginal);
    expect(
      pruneInstalledPackageDist({
        packageRoot,
        expectedFiles: new Set(),
        unlinkSync,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/stale.js"]);
    expect(unlinkSync).toHaveBeenCalledWith(path.join(packageRoot, "dist", "stale.js"));
    await expectPathMissing(path.join(packageRoot, "dist", "stale.js"));
  });
});
