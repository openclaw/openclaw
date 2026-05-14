import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  clearLoadPluginMetadataSnapshotMemo,
  loadPluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

const loadPluginRegistrySnapshotWithMetadata = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndex = vi.hoisted(() => vi.fn());

vi.mock("./plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshotWithMetadata: (params: unknown) =>
      loadPluginRegistrySnapshotWithMetadata(params),
  };
});

vi.mock("./manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex: (params: unknown) =>
      loadPluginManifestRegistryForInstalledIndex(params),
  };
});

const tempDirs: string[] = [];

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-metadata-memo-"));
  tempDirs.push(dir);
  return dir;
}

function touchPersistedIndex(stateDir: string, value = 1): void {
  const indexPath = path.join(stateDir, "plugins", "installs.json");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify({ value }));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function writePersistedIndex(params: {
  manifestPath?: string;
  packageJsonPath?: string;
  pluginId: string;
  source?: string;
  stateDir: string;
}): void {
  const pluginDir = path.join(params.stateDir, "extensions", params.pluginId);
  const manifestPath = params.manifestPath ?? path.join(pluginDir, "openclaw.plugin.json");
  const packageJsonPath = params.packageJsonPath ?? path.join(pluginDir, "package.json");
  writeJson(path.join(params.stateDir, "plugins", "installs.json"), {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: {},
    diagnostics: [],
    plugins: [
      {
        pluginId: params.pluginId,
        manifestPath,
        manifestHash: `${params.pluginId}-manifest`,
        rootDir: pluginDir,
        ...(params.source ? { source: params.source } : {}),
        origin: "global",
        enabled: true,
        packageJson: { path: "package.json", hash: `${params.pluginId}-package` },
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
  });
  writeJson(manifestPath, { id: params.pluginId });
  writeJson(packageJsonPath, { name: params.pluginId });
}

function writeRecoverableNpmPlugin(params: {
  packageName: string;
  pluginId: string;
  stateDir: string;
  version: string;
}): void {
  const packageDir = path.join(params.stateDir, "npm", "node_modules", params.packageName);
  writeJson(path.join(params.stateDir, "npm", "package.json"), {
    dependencies: {
      [params.packageName]: "1.0.0",
    },
  });
  writeJson(path.join(packageDir, "package.json"), {
    name: params.packageName,
    version: params.version,
    openclaw: {
      extensions: ["."],
    },
  });
  writeJson(path.join(packageDir, "openclaw.plugin.json"), { id: params.pluginId });
}

function makeIndex(pluginId = "demo"): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: {},
    diagnostics: [],
    plugins: [
      {
        pluginId,
        manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
        manifestHash: `${pluginId}-manifest`,
        rootDir: `/plugins/${pluginId}`,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
  };
}

function makeManifestRegistry(pluginId = "demo"): PluginManifestRegistry {
  const plugin: PluginManifestRecord = {
    id: pluginId,
    name: pluginId,
    channels: [],
    providers: [pluginId],
    cliBackends: [],
    skills: [],
    hooks: [],
    commandAliases: [{ name: `${pluginId}-command` }],
    rootDir: `/plugins/${pluginId}`,
    source: `/plugins/${pluginId}/index.js`,
    manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
    origin: "global",
  };
  return { plugins: [plugin], diagnostics: [] };
}

function firstPlugin(
  snapshot: ReturnType<typeof loadPluginMetadataSnapshot>,
): PluginManifestRecord {
  const plugin = snapshot.plugins[0];
  if (!plugin) {
    throw new Error("expected memo test fixture plugin");
  }
  return plugin;
}

function firstCommandAlias(
  plugin: PluginManifestRecord,
): NonNullable<PluginManifestRecord["commandAliases"]>[number] {
  const commandAlias = plugin.commandAliases?.[0];
  if (!commandAlias) {
    throw new Error("expected memo test fixture command alias");
  }
  return commandAlias;
}

describe("loadPluginMetadataSnapshot process memo", () => {
  beforeEach(() => {
    clearLoadPluginMetadataSnapshotMemo();
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry());
  });

  afterEach(() => {
    clearLoadPluginMetadataSnapshotMemo();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses persisted metadata snapshots for repeated process lookups", () => {
    const stateDir = tempStateDir();
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    const firstRecord = firstPlugin(first);
    firstRecord.providers.push("first-mutated");
    firstCommandAlias(firstRecord).name = "first-command-mutated";
    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    const secondRecord = firstPlugin(second);
    secondRecord.providers.push("second-mutated");
    firstCommandAlias(secondRecord).name = "second-command-mutated";
    const third = loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(third.plugins[0]?.providers).toEqual(["demo"]);
    expect(third.plugins[0]?.commandAliases?.[0]?.name).toBe("demo-command");
    expect(second.manifestRegistry.plugins[0]).toBe(second.plugins[0]);
    expect(second.byPluginId.get("demo")).toBe(second.plugins[0]);
  });

  it("memoizes policy-stale derived snapshots used by validation callers", () => {
    const stateDir = tempStateDir();
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex(),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-policy",
          message: "policy changed",
        },
      ],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledOnce();
  });

  it.each([
    ["persisted-registry-missing", undefined],
    ["persisted-registry-stale-source", undefined],
    ["persisted-registry-disabled", undefined],
    [undefined, { preferPersisted: false }],
  ])("does not memoize derived snapshots for %s diagnostics", (code, options) => {
    const stateDir = tempStateDir();
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex(),
      diagnostics: code ? [{ level: "warn", code, message: "registry not reusable" }] : [],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir, ...options });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir, ...options });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("refreshes when the persisted registry file changes", () => {
    const stateDir = tempStateDir();
    touchPersistedIndex(stateDir, 1);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    touchPersistedIndex(stateDir, 22);
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("refreshes when persisted plugin metadata files change in the same process", () => {
    const stateDir = tempStateDir();
    const manifestPath = path.join(stateDir, "extensions", "demo", "openclaw.plugin.json");
    writePersistedIndex({ manifestPath, pluginId: "demo", stateDir });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    writeJson(manifestPath, { id: "demo", version: "0.2.0" });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(2);
  });

  it("refreshes when recovered managed npm package metadata changes", () => {
    const stateDir = tempStateDir();
    writeRecoverableNpmPlugin({
      packageName: "recovered-plugin",
      pluginId: "recovered",
      stateDir,
      version: "1.0.0",
    });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    writeRecoverableNpmPlugin({
      packageName: "recovered-plugin",
      pluginId: "recovered",
      stateDir,
      version: "1.0.1",
    });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(2);
  });

  it("does not fingerprint persisted plugin paths outside the plugin root", () => {
    const stateDir = tempStateDir();
    const outsideManifestPath = path.join(stateDir, "outside", "openclaw.plugin.json");
    const outsideSourcePath = path.join(stateDir, "outside", "index.js");
    writePersistedIndex({
      manifestPath: outsideManifestPath,
      pluginId: "demo",
      source: outsideSourcePath,
      stateDir,
    });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });
    const statSpy = vi.spyOn(fs, "statSync");
    const readSpy = vi.spyOn(fs, "readFileSync");

    try {
      loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
    }

    expect(statSpy.mock.calls.some(([filePath]) => filePath === outsideManifestPath)).toBe(false);
    expect(statSpy.mock.calls.some(([filePath]) => filePath === outsideSourcePath)).toBe(false);
    expect(readSpy.mock.calls.some(([filePath]) => filePath === outsideManifestPath)).toBe(false);
    expect(readSpy.mock.calls.some(([filePath]) => filePath === outsideSourcePath)).toBe(false);
  });

  it("does not hash symlinked persisted plugin files that escape the plugin root", () => {
    const stateDir = tempStateDir();
    const pluginDir = path.join(stateDir, "extensions", "demo");
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const outsideManifestPath = path.join(stateDir, "outside", "openclaw.plugin.json");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeJson(outsideManifestPath, { id: "outside" });
    fs.symlinkSync(outsideManifestPath, manifestPath);
    writeJson(path.join(stateDir, "plugins", "installs.json"), {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 1,
      installRecords: {},
      diagnostics: [],
      plugins: [
        {
          pluginId: "demo",
          manifestPath,
          manifestHash: "demo-manifest",
          rootDir: pluginDir,
          origin: "global",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
          },
          compat: [],
        },
      ],
    });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });
    const readSpy = vi.spyOn(fs, "readFileSync");

    try {
      loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    } finally {
      readSpy.mockRestore();
    }

    expect(readSpy.mock.calls.some(([filePath]) => filePath === outsideManifestPath)).toBe(false);
  });
});
