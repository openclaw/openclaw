import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { transformConfigFileWithRetry } from "../config/mutate.js";
import { registerManagedRuntimeConfigWriteOwner } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireFileLock, FILE_LOCK_TIMEOUT_ERROR_CODE } from "../infra/file-lock.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolvePluginInstallDir } from "./install-paths.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { uninstallManagedPlugin } from "./management-uninstall.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { withPluginSourceCleanup } from "./source-cleanup.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { mkdirSafeDir } from "./test-helpers/fs-fixtures.js";
import { applyPluginUninstallDirectoryRemoval } from "./uninstall.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function expectConfigSourceLocked(pathname: string) {
  const contended = await acquireFileLock(pathname, {
    retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
    stale: 30_000,
  }).then(
    async (lock) => {
      await lock.release();
      return false;
    },
    (error: unknown) => {
      expect(error).toMatchObject({ code: FILE_LOCK_TIMEOUT_ERROR_CODE });
      return true;
    },
  );
  expect.soft(contended).toBe(true);
}

async function createUninstallSourceFixture(
  source: "root" | "shared include",
  keepParentLoadPath = false,
) {
  const root = tempDirs.make("managed-uninstall-source-");
  const configPath = path.join(root, "openclaw.json");
  const includePath = path.join(root, "plugins.json");
  const writerConfigPath = source === "root" ? configPath : path.join(root, "other.json");
  const stateDir = path.join(root, "state");
  const pluginRoot = resolvePluginInstallDir("cleanup-owned", path.join(stateDir, "extensions"));
  const parentLoadPath = path.dirname(pluginRoot);
  mkdirSafeDir(pluginRoot);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "cleanup-owned",
    manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
  });
  const retainedFile = path.join(pluginRoot, "keep.txt");
  fs.writeFileSync(retainedFile, "owned plugin bytes");
  const config: OpenClawConfig = {
    plugins: {
      entries: { [fixture.pluginId]: { enabled: true } },
      load: { paths: [pluginRoot, ...(keepParentLoadPath ? [parentLoadPath] : [])] },
    },
  };
  if (source === "shared include") {
    const rootRaw = JSON.stringify({ plugins: { $include: "./plugins.json" } });
    fs.writeFileSync(configPath, rootRaw);
    fs.writeFileSync(writerConfigPath, rootRaw);
    fs.writeFileSync(includePath, JSON.stringify(config.plugins));
  } else {
    fs.writeFileSync(configPath, JSON.stringify(config));
  }
  vi.stubEnv("OPENCLAW_HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  // Managed uninstall delegates activation to its Gateway's config owner.
  onTestFinished(registerManagedRuntimeConfigWriteOwner(configPath));
  const installRecord = {
    source: "path" as const,
    sourcePath: path.join(root, "source"),
    installPath: pluginRoot,
  };
  await writePersistedInstalledPluginIndex(
    loadInstalledPluginIndex({
      config,
      env: process.env,
      installRecords: { [fixture.pluginId]: installRecord },
    }),
  );
  const addLoadPath = (loadPath: string, beforeCommit?: () => void) =>
    transformConfigFileWithRetry({
      base: "source",
      writeOptions: {
        ownedConfigPathForWrite: writerConfigPath,
        expectedConfigPath: writerConfigPath,
        afterWrite: { mode: "none", reason: "synthetic concurrent config writer" },
        beforeCommit,
      },
      transform: (current) => ({
        nextConfig: {
          ...current,
          plugins: {
            ...current.plugins,
            load: {
              ...current.plugins?.load,
              paths: [...(current.plugins?.load?.paths ?? []), loadPath],
            },
          },
        },
      }),
    });
  return {
    root,
    configPath,
    includePath,
    pluginRoot,
    parentLoadPath,
    retainedFile,
    pluginId: fixture.pluginId,
    installRecord,
    addLoadPath,
  };
}

it.each(["root", "shared include"] as const)(
  "retains files newly referenced by a %s writer during uninstall drain",
  async (source) => {
    const fixture = await createUninstallSourceFixture(source);
    const alias = path.join(fixture.root, "adopted-plugin");
    fs.symlinkSync(fixture.pluginRoot, alias, process.platform === "win32" ? "junction" : "dir");
    const entered = createDeferred();
    const release = createDeferred();
    const pending = uninstallManagedPlugin({
      pluginId: fixture.pluginId,
      applyRuntime: async () => {
        entered.resolve();
        await release.promise;
        return {
          operationId: "uninstall-drain",
          generation: 1,
          pluginIds: [fixture.pluginId],
        };
      },
    });
    void pending.catch(() => {});
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("uninstall finished before drain");
        }),
      ]);
      await fixture.addLoadPath(alias);
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
    await expect
      .soft(pending)
      .rejects.toThrow(
        `Plugin source is still referenced by config: ${fixture.pluginRoot}. Remove the load-path reference and retry.`,
      );
    expect(fs.readFileSync(fixture.retainedFile, "utf8")).toBe("owned plugin bytes");
    expect((await readConfigFileSnapshot()).config.plugins?.load?.paths).toContain(alias);
    expect((await readPersistedInstalledPluginIndex())?.installRecords[fixture.pluginId]).toEqual(
      fixture.installRecord,
    );
  },
);

it.each(["root", "shared include"] as const)(
  "holds %s ownership until uninstall deletion settles before admitting a writer",
  async (source) => {
    const fixture = await createUninstallSourceFixture(source, true);
    const otherPath = path.join(fixture.root, "other-plugins");
    mkdirSafeDir(otherPath);
    const entered = createDeferred();
    const release = createDeferred();
    const unlink = fsAsync.unlink.bind(fsAsync);
    const rmdir = fsAsync.rmdir.bind(fsAsync);
    let held = false;
    let removed = false;
    const unlinkSpy = vi.spyOn(fsAsync, "unlink").mockImplementation(async (filename) => {
      if (!held && path.dirname(String(filename)) === fixture.pluginRoot) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      await unlink(filename);
    });
    const rmdirSpy = vi.spyOn(fsAsync, "rmdir").mockImplementation(async (filename) => {
      await rmdir(filename);
      if (String(filename) === fixture.pluginRoot) {
        removed = true;
      }
    });
    const pending = uninstallManagedPlugin({
      pluginId: fixture.pluginId,
      applyRuntime: async () => ({
        operationId: "uninstall-delete",
        generation: 1,
        pluginIds: [fixture.pluginId],
      }),
    });
    void pending.catch(() => {});
    let writer: ReturnType<typeof fixture.addLoadPath> | undefined;
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("uninstall finished before deletion");
        }),
      ]);
      const sources = [
        fixture.configPath,
        ...(source === "shared include" ? [fixture.includePath] : []),
      ];
      for (const pathname of sources) {
        await expectConfigSourceLocked(pathname);
      }
      writer = fixture.addLoadPath(otherPath, () => expect(removed).toBe(true));
    } finally {
      release.resolve();
      await Promise.allSettled([pending, ...(writer ? [writer] : [])]);
      unlinkSpy.mockRestore();
      rmdirSpy.mockRestore();
    }
    await pending;
    await writer;
    expect(fs.existsSync(fixture.pluginRoot)).toBe(false);
    expect((await readConfigFileSnapshot()).config.plugins?.load?.paths).toEqual([
      fixture.parentLoadPath,
      otherPath,
    ]);
  },
);

it("locks an aliased root config's target while deleting a retired plugin source", async () => {
  const root = tempDirs.make("managed-source-config-alias-");
  const configPath = path.join(root, "openclaw.json");
  const canonicalConfigPath = path.join(root, "source-config.json");
  const target = path.join(root, "retired-plugin");
  const leaf = path.join(target, "keep.txt");
  fs.writeFileSync(canonicalConfigPath, "{}\n");
  fs.symlinkSync(canonicalConfigPath, configPath, "file");
  mkdirSafeDir(target);
  fs.writeFileSync(leaf, "retired plugin bytes");
  vi.stubEnv("OPENCLAW_HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  const entered = createDeferred();
  const release = createDeferred();
  const unlink = fsAsync.unlink.bind(fsAsync);
  const unlinkSpy = vi.spyOn(fsAsync, "unlink").mockImplementation(async (filename) => {
    if (String(filename) === leaf) {
      entered.resolve();
      await release.promise;
    }
    await unlink(filename);
  });
  const pending = withPluginSourceCleanup(target, { configPath }, (assertCurrent) =>
    applyPluginUninstallDirectoryRemoval({ target }, assertCurrent),
  );
  void pending.catch(() => {});
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("source cleanup finished before deletion");
      }),
    ]);
    await expectConfigSourceLocked(canonicalConfigPath);
  } finally {
    release.resolve();
    await pending.catch(() => {});
    unlinkSpy.mockRestore();
  }
  await expect(pending).resolves.toEqual({ directoryRemoved: true, warnings: [] });
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(canonicalConfigPath, "utf8")).toBe("{}\n");
});
