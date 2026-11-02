import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
} from "./install-transaction.js";
import type { PluginInstallArtifactConsentRequest } from "./install-types.js";
import { installPluginFromPath, PLUGIN_INSTALL_ERROR_CODE } from "./install.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { packToArchive } from "./test-helpers/archive-fixtures.js";
import { createSyncSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";
import { createBundleInstallFixtureFactory } from "./test-helpers/install-fixtures.js";

const suiteTempRootTracker = createSyncSuiteTempRootTracker("openclaw-plugin-install-path");
const setupBundleInstallFixture = createBundleInstallFixtureFactory(
  suiteTempRootTracker.makeTempDir,
);

function setupNativePluginInstallFixture() {
  const caseDir = suiteTempRootTracker.makeTempDir();
  const pluginDir = path.join(caseDir, "plugin-src");
  const extensionsDir = path.join(caseDir, "state", "extensions");
  writeArtifacts(pluginDir, {
    "package.json": {
      name: "symlink-plugin",
      version: "1.0.0",
      openclaw: { extensions: ["./dist/index.js"] },
    },
    "dist/index.js": "export {};\n",
    "openclaw.plugin.json": {
      id: "symlink-plugin",
      configSchema: { type: "object", properties: {} },
    },
  });
  return { caseDir, pluginDir, path: pluginDir, extensionsDir };
}

afterAll(() => suiteTempRootTracker.cleanup());

function archive(pluginDir: string) {
  return packToArchive({
    pkgDir: pluginDir,
    outDir: suiteTempRootTracker.makeTempDir(),
    outName: "plugin.tgz",
  });
}

function exists(root: string, ...parts: string[]) {
  return fs.existsSync(path.join(root, ...parts));
}

it.each(["directory", "archive"] as const)(
  "retains caller-owned rollback and staged artifact review for a %s",
  async (source) => {
    const { pluginDir, extensionsDir } = setupNativePluginInstallFixture();
    const installPath = source === "archive" ? await archive(pluginDir) : pluginDir;
    let reviewed = false;
    const result = await installPluginFromPath(
      requestDeferredPluginInstall({
        path: installPath,
        extensionsDir,
        onBeforePluginArtifactCommit: async ({
          stagedArtifactDir,
        }: PluginInstallArtifactConsentRequest) => {
          expect(fs.readFileSync(path.join(stagedArtifactDir, "dist", "index.js"), "utf8")).toBe(
            "export {};\n",
          );
          reviewed = true;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(reviewed).toBe(true);
    const transaction = resolvePluginInstallTransaction(result);
    expect(transaction).toBeDefined();
    expect(exists(extensionsDir, "symlink-plugin", "package.json")).toBe(true);
    await transaction!.rollback();
    expect(exists(extensionsDir, "symlink-plugin")).toBe(false);
  },
);

it.each(["native plugin", "bundle"] as const)(
  "does not publish an archived %s after authority closes during artifact review",
  async (kind) => {
    const { pluginDir, extensionsDir } =
      kind === "native plugin"
        ? setupNativePluginInstallFixture()
        : setupBundleInstallFixture({ bundleFormat: "claude", name: "Guarded Bundle" });
    const pluginId = kind === "native plugin" ? "symlink-plugin" : "guarded-bundle";
    const archivePath = await archive(pluginDir);
    let authorityActive = true;
    const result = await installPluginFromPath({
      path: archivePath,
      extensionsDir,
      onBeforePluginArtifactCommit: async () => {
        authorityActive = false;
      },
      beforePersistentApply: () => {
        if (!authorityActive) {
          throw new Error("plugin installation authority closed");
        }
      },
    });

    expect(authorityActive).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("plugin installation authority closed"),
    });
    expect(exists(extensionsDir, pluginId)).toBe(false);
  },
);

it("rejects managed plain file plugin installs through path install", async () => {
  const baseDir = suiteTempRootTracker.makeTempDir();
  const extensionsDir = path.join(baseDir, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });

  const sourcePath = path.join(baseDir, "payload.js");
  fs.writeFileSync(sourcePath, "console.log('SAFE');\n", "utf-8");

  expect(await installPluginFromPath({ path: sourcePath, extensionsDir })).toMatchObject({
    ok: false,
    code: PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN,
    error:
      "Plain file plugin installs are not supported. Install a plugin directory or archive that contains openclaw.plugin.json, or list standalone plugin files in plugins.load.paths.",
  });
});

it.runIf(process.platform !== "win32")(
  "installs local plugin directories when the managed extensions root is a symlink",
  async () => {
    const { caseDir, pluginDir, extensionsDir } = setupNativePluginInstallFixture();
    const realExtensionsDir = path.join(caseDir, "data", "extensions");
    fs.mkdirSync(realExtensionsDir, { recursive: true });
    fs.mkdirSync(path.dirname(extensionsDir), { recursive: true });
    fs.symlinkSync(realExtensionsDir, extensionsDir, "dir");

    const result = await installPluginFromPath({ path: pluginDir, extensionsDir });
    assert(result.ok, JSON.stringify(result));
    expect(result.targetDir).toBe(path.join(extensionsDir, "symlink-plugin"));
    expect(exists(realExtensionsDir, "symlink-plugin", "package.json")).toBe(true);
  },
);

it("installs agent bundles from an archive path", async () => {
  const { pluginDir, extensionsDir } = setupBundleInstallFixture({
    bundleFormat: "agent",
    name: "Portable Sample",
  });
  const result = await installPluginFromPath({ path: await archive(pluginDir), extensionsDir });
  assert(result.ok, JSON.stringify(result));
  expect(result.pluginId).toBe("portable-sample");
  expect(exists(result.targetDir, "plugin.json")).toBe(true);
});
