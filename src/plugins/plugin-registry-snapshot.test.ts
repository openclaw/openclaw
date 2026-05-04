import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex, type InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry-snapshot", tempDirs);
}

function createHermeticEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    OPENCLAW_VERSION: "2026.4.26",
    VITEST: "true",
  };
}

function writeManifestlessClaudeBundle(rootDir: string) {
  fs.mkdirSync(path.join(rootDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "skills", "SKILL.md"), "# Workspace skill\n", "utf8");
}

function writePackagePlugin(rootDir: string, id = "demo") {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default { register() {} };\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id,
      description: "one",
      configSchema: { type: "object" },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0" }),
    "utf8",
  );
}

function replaceFilePreservingSizeAndMtime(filePath: string, contents: string) {
  const previous = fs.statSync(filePath);
  expect(Buffer.byteLength(contents)).toBe(previous.size);
  fs.writeFileSync(filePath, contents, "utf8");
  fs.utimesSync(filePath, previous.atime, previous.mtime);
}

function createManifestlessClaudeBundleIndex(params: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
}): InstalledPluginIndex {
  return loadInstalledPluginIndex({
    config: {
      plugins: {
        load: { paths: [params.rootDir] },
      },
    },
    env: params.env,
  });
}

describe("loadPluginRegistrySnapshotWithMetadata", () => {
  it("keeps persisted manifestless Claude bundles on the fast path", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writeManifestlessClaudeBundle(rootDir);
    const index = createManifestlessClaudeBundleIndex({ rootDir, env });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps persisted package plugins when file hashes match", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir);
    const index = loadInstalledPluginIndex({ config, env });
    const [record] = index.plugins;
    expect(record?.manifestFile).toBeDefined();
    expect(record?.packageJson?.fileSignature).toBeDefined();
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toEqual([]);
  });

  it("derives fresh package plugins when persisted install records are missing from plugins", () => {
    const tempRoot = makeTempDir();
    const presentRoot = path.join(tempRoot, "present");
    const missingRoot = path.join(tempRoot, "missing");
    const stateDir = path.join(tempRoot, "state");
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const config = {
      plugins: {
        entries: {
          missing: { enabled: true },
        },
      },
    };
    const installRecords = {
      present: { source: "path", installPath: presentRoot },
      missing: { source: "path", installPath: missingRoot },
    } satisfies Record<string, PluginInstallRecord>;
    writePackagePlugin(presentRoot, "present");
    writePackagePlugin(missingRoot, "missing");
    const freshIndex = loadInstalledPluginIndex({
      config,
      env,
      installRecords,
      now: () => new Date(0),
    });
    const staleIndex: InstalledPluginIndex = {
      ...freshIndex,
      plugins: freshIndex.plugins.filter((plugin) => plugin.pluginId !== "missing"),
    };
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
      now: () => new Date(0),
    });

    expect(result.source).toBe("derived");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId).toSorted()).toEqual([
      "missing",
      "present",
    ]);
  });

  it("detects same-size same-mtime manifest replacements", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir);
    const index = loadInstalledPluginIndex({ config, env });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    replaceFilePreservingSizeAndMtime(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        description: "two",
        configSchema: { type: "object" },
      }),
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
  });

  it("detects same-size same-mtime package.json replacements", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir);
    const index = loadInstalledPluginIndex({ config, env });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    replaceFilePreservingSizeAndMtime(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.1" }),
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
  });

  it("detects package.json replacements even when stored stat fields still match", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir);
    const index = loadInstalledPluginIndex({ config, env });

    replaceFilePreservingSizeAndMtime(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.1" }),
    );
    const stat = fs.statSync(path.join(rootDir, "package.json"));
    const [plugin] = index.plugins;
    if (!plugin?.packageJson) {
      throw new Error("expected test plugin package metadata");
    }
    const stalePlugin = {
      ...plugin,
      packageJson: {
        ...plugin.packageJson,
        fileSignature: {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        },
      },
    };
    const staleIndex: InstalledPluginIndex = {
      ...index,
      plugins: [stalePlugin, ...index.plugins.slice(1)],
    };
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
  });
});
