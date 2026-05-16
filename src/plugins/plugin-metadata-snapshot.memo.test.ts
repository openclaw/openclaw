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
  setupSource?: string;
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
        ...(params.setupSource ? { setupSource: params.setupSource } : {}),
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
  writeRootManifest?: boolean;
}): void {
  const packageDir = path.join(params.stateDir, "npm", "node_modules", params.packageName);
  if (params.writeRootManifest !== false) {
    writeJson(path.join(params.stateDir, "npm", "package.json"), {
      dependencies: {
        [params.packageName]: "1.0.0",
      },
    });
  }
  writeJson(path.join(packageDir, "package.json"), {
    name: params.packageName,
    version: params.version,
    openclaw: {
      extensions: ["."],
    },
  });
  writeJson(path.join(packageDir, "openclaw.plugin.json"), { id: params.pluginId });
}

function writePersistedInstallRecords(
  stateDir: string,
  installRecords: Record<string, Record<string, unknown>>,
): void {
  writeJson(path.join(stateDir, "plugins", "installs.json"), {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords,
    diagnostics: [],
    plugins: [],
  });
}

function makeIndex(
  pluginId = "demo",
  options: {
    manifestPath?: string;
    rootDir?: string;
  } = {},
): InstalledPluginIndex {
  const rootDir = options.rootDir ?? `/plugins/${pluginId}`;
  const manifestPath = options.manifestPath ?? path.join(rootDir, "openclaw.plugin.json");
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
        manifestPath,
        manifestHash: `${pluginId}-manifest`,
        rootDir,
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

  it("memoizes source-stale derived snapshots after persisted registry freshness checks", () => {
    const stateDir = tempStateDir();
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex(),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledOnce();
  });

  it("keeps separate memo entries for workspace-scoped and unscoped callers", () => {
    const stateDir = tempStateDir();
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockImplementation(
      (params: { workspaceDir?: string }) => ({
        source: "derived",
        snapshot: makeIndex(params.workspaceDir ? "workspace" : "unscoped"),
        diagnostics: [
          {
            level: "warn",
            code: "persisted-registry-stale-policy",
            message: "policy changed",
          },
        ],
      }),
    );

    const workspaceInitial = loadPluginMetadataSnapshot({
      config: {},
      env: {},
      stateDir,
      workspaceDir: "/workspace",
    });
    const unscopedInitial = loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    const workspaceAgain = loadPluginMetadataSnapshot({
      config: {},
      env: {},
      stateDir,
      workspaceDir: "/workspace",
    });
    const unscopedAgain = loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(workspaceInitial.index.plugins[0]?.pluginId).toBe("workspace");
    expect(unscopedInitial.index.plugins[0]?.pluginId).toBe("unscoped");
    expect(workspaceAgain.index.plugins[0]?.pluginId).toBe("workspace");
    expect(unscopedAgain.index.plugins[0]?.pluginId).toBe("unscoped");
  });

  it("does not let one workspace's discovery watches invalidate another workspace slot", () => {
    const stateDir = tempStateDir();
    const firstWorkspaceDir = path.join(stateDir, "workspace-a");
    const secondWorkspaceDir = path.join(stateDir, "workspace-b");
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockImplementation(
      (params: { workspaceDir?: string }) => ({
        source: "derived",
        snapshot: makeIndex(params.workspaceDir === firstWorkspaceDir ? "first" : "second"),
        diagnostics: [
          {
            level: "warn",
            code: "persisted-registry-stale-source",
            message: "source changed",
          },
        ],
      }),
    );

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir, workspaceDir: firstWorkspaceDir });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir, workspaceDir: secondWorkspaceDir });
    writeJson(
      path.join(firstWorkspaceDir, ".openclaw", "extensions", "new-plugin", "package.json"),
      { name: "new-plugin" },
    );
    const secondAgain = loadPluginMetadataSnapshot({
      config: {},
      env: {},
      stateDir,
      workspaceDir: secondWorkspaceDir,
    });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(secondAgain.index.plugins[0]?.pluginId).toBe("second");
  });

  it("keeps separate source-stale memo entries reachable across registry contexts", () => {
    const firstStateDir = tempStateDir();
    const secondStateDir = tempStateDir();
    touchPersistedIndex(firstStateDir);
    touchPersistedIndex(secondStateDir);
    loadPluginRegistrySnapshotWithMetadata.mockImplementation((params: { stateDir?: string }) => ({
      source: "derived",
      snapshot: makeIndex(params.stateDir === firstStateDir ? "first" : "second"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    }));

    const firstInitial = loadPluginMetadataSnapshot({
      config: {},
      env: {},
      stateDir: firstStateDir,
    });
    const secondInitial = loadPluginMetadataSnapshot({
      config: {},
      env: {},
      stateDir: secondStateDir,
    });
    const firstAgain = loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir: firstStateDir });
    const secondAgain = loadPluginMetadataSnapshot({
      config: {},
      env: {},
      stateDir: secondStateDir,
    });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(firstInitial.index.plugins[0]?.pluginId).toBe("first");
    expect(secondInitial.index.plugins[0]?.pluginId).toBe("second");
    expect(firstAgain.index.plugins[0]?.pluginId).toBe("first");
    expect(secondAgain.index.plugins[0]?.pluginId).toBe("second");
  });

  it("invalidates source-stale memo entries when stale persisted plugin files appear", () => {
    const stateDir = tempStateDir();
    const staleSourcePath = path.join(stateDir, "extensions", "stale", "index.js");
    writePersistedIndex({ pluginId: "stale", source: staleSourcePath, stateDir });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    writeJson(staleSourcePath, "restored");
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("invalidates source-stale memo entries when orphaned diagnostic sources appear", () => {
    const stateDir = tempStateDir();
    const orphanedDiagnosticSource = path.join(stateDir, "extensions", "orphaned", "index.js");
    writeJson(path.join(stateDir, "plugins", "installs.json"), {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [
        {
          level: "warn",
          pluginId: "orphaned",
          source: orphanedDiagnosticSource,
          message: "missing diagnostic source",
        },
      ],
    });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    writeJson(orphanedDiagnosticSource, "restored");
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("invalidates source-stale memo entries when discovery roots gain plugins", () => {
    const stateDir = tempStateDir();
    const loadPath = path.join(stateDir, "configured-plugins");
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });
    const config = { plugins: { load: { paths: [loadPath] } } };

    loadPluginMetadataSnapshot({ config, env: {}, stateDir });
    writeJson(path.join(loadPath, "new-plugin", "openclaw.plugin.json"), { id: "new-plugin" });
    loadPluginMetadataSnapshot({ config, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("invalidates policy-stale memo entries when discovery roots gain plugins", () => {
    const stateDir = tempStateDir();
    const loadPath = path.join(stateDir, "configured-plugins");
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-policy",
          message: "policy changed",
        },
      ],
    });
    const config = { plugins: { load: { paths: [loadPath] } } };

    loadPluginMetadataSnapshot({ config, env: {}, stateDir });
    writeJson(path.join(loadPath, "new-plugin", "openclaw.plugin.json"), { id: "new-plugin" });
    loadPluginMetadataSnapshot({ config, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("invalidates source-stale memo entries when existing discovery children gain plugin files", () => {
    const stateDir = tempStateDir();
    const loadPath = path.join(stateDir, "configured-plugins");
    const pluginDir = path.join(loadPath, "new-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });
    const config = { plugins: { load: { paths: [loadPath] } } };

    loadPluginMetadataSnapshot({ config, env: {}, stateDir });
    writeJson(path.join(pluginDir, "package.json"), {
      name: "new-plugin",
      openclaw: { extensions: ["index.js"] },
    });
    loadPluginMetadataSnapshot({ config, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("invalidates source-stale memo entries when discovery child marker files change", () => {
    const stateDir = tempStateDir();
    const loadPath = path.join(stateDir, "configured-plugins");
    const pluginDir = path.join(loadPath, "new-plugin");
    writeJson(path.join(pluginDir, "package.json"), { name: "new-plugin" });
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });
    const config = { plugins: { load: { paths: [loadPath] } } };

    loadPluginMetadataSnapshot({ config, env: {}, stateDir });
    writeJson(path.join(pluginDir, "package.json"), {
      name: "new-plugin",
      openclaw: { extensions: ["index.js"] },
    });
    loadPluginMetadataSnapshot({ config, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("invalidates source-stale memo entries when nested bundle default markers appear", () => {
    const stateDir = tempStateDir();
    const loadPath = path.join(stateDir, "configured-plugins");
    const pluginDir = path.join(loadPath, "cursor-bundle");
    writeJson(path.join(pluginDir, ".cursor-plugin", "plugin.json"), { name: "cursor-bundle" });
    fs.mkdirSync(path.join(pluginDir, ".cursor"), { recursive: true });
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });
    const config = { plugins: { load: { paths: [loadPath] } } };

    loadPluginMetadataSnapshot({ config, env: {}, stateDir });
    fs.mkdirSync(path.join(pluginDir, ".cursor", "commands"), { recursive: true });
    loadPluginMetadataSnapshot({ config, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("invalidates source-stale memo entries when package-declared nested entry files appear", () => {
    const stateDir = tempStateDir();
    const loadPath = path.join(stateDir, "configured-plugins");
    const pluginDir = path.join(loadPath, "nested-plugin");
    fs.mkdirSync(path.join(pluginDir, "src"), { recursive: true });
    writeJson(path.join(pluginDir, "package.json"), {
      name: "nested-plugin",
      openclaw: { extensions: ["src/index.ts"] },
    });
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });
    const config = { plugins: { load: { paths: [loadPath] } } };

    loadPluginMetadataSnapshot({ config, env: {}, stateDir });
    fs.writeFileSync(path.join(pluginDir, "src", "index.js"), "export {};\n");
    loadPluginMetadataSnapshot({ config, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed package manifests while caching source-stale discovery watches", () => {
    const stateDir = tempStateDir();
    const loadPath = path.join(stateDir, "configured-plugins");
    const pluginDir = path.join(loadPath, "malformed-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "package.json"), "{", "utf8");
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });
    const config = { plugins: { load: { paths: [loadPath] } } };

    loadPluginMetadataSnapshot({ config, env: {}, stateDir });
    loadPluginMetadataSnapshot({ config, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(1);
  });

  it("does not read package-declared entry watches from package manifests outside the plugin root", () => {
    const stateDir = tempStateDir();
    const loadPath = path.join(stateDir, "configured-plugins");
    const pluginDir = path.join(loadPath, "symlinked-package");
    const sourceDir = path.join(pluginDir, "src");
    const outsidePackageJson = path.join(stateDir, "outside", "package.json");
    fs.mkdirSync(sourceDir, { recursive: true });
    writeJson(outsidePackageJson, {
      name: "outside-package",
      openclaw: { extensions: ["src/index.ts"] },
    });
    fs.symlinkSync(outsidePackageJson, path.join(pluginDir, "package.json"));
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });
    const config = { plugins: { load: { paths: [loadPath] } } };

    loadPluginMetadataSnapshot({ config, env: {}, stateDir });
    fs.writeFileSync(path.join(sourceDir, "index.js"), "export {};\n");
    loadPluginMetadataSnapshot({ config, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(1);
  });

  it("invalidates source-stale memo entries when bundled source checkout roots gain plugins", () => {
    const stateDir = tempStateDir();
    const packageRoot = path.join(stateDir, "openclaw-package");
    const stockRoot = path.join(packageRoot, "dist", "extensions");
    const sourceRoot = path.join(packageRoot, "extensions");
    fs.mkdirSync(stockRoot, { recursive: true });
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("stable"),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-source",
          message: "source changed",
        },
      ],
    });
    const env = { OPENCLAW_BUNDLED_PLUGINS_DIR: stockRoot };

    loadPluginMetadataSnapshot({ config: {}, env, stateDir });
    writeJson(path.join(sourceRoot, "new-plugin", "openclaw.plugin.json"), { id: "new-plugin" });
    loadPluginMetadataSnapshot({ config: {}, env, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used snapshot memo entry after the cap", () => {
    const stateDir = tempStateDir();
    touchPersistedIndex(stateDir);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });

    for (let index = 0; index < 8; index += 1) {
      loadPluginMetadataSnapshot({
        config: {},
        env: {},
        stateDir,
        workspaceDir: `/workspace-${index}`,
      });
    }
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir, workspaceDir: "/workspace-0" });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir, workspaceDir: "/workspace-8" });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir, workspaceDir: "/workspace-0" });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir, workspaceDir: "/workspace-1" });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(10);
  });

  it("refreshes policy-stale derived snapshots when derived plugin files change", () => {
    const stateDir = tempStateDir();
    touchPersistedIndex(stateDir);
    const pluginDir = path.join(stateDir, "current", "derived");
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    writeJson(manifestPath, { id: "derived", version: "1.0.0" });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: makeIndex("derived", { manifestPath, rootDir: pluginDir }),
      diagnostics: [
        {
          level: "warn",
          code: "persisted-registry-stale-policy",
          message: "policy changed",
        },
      ],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry("derived"));

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    writeJson(manifestPath, { id: "derived", version: "2.0.0", commandAliases: [{ name: "new" }] });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["persisted-registry-missing", undefined],
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

  it("reuses the expanded freshness fingerprint on hot cache hits", () => {
    const stateDir = tempStateDir();
    const manifestPath = path.join(stateDir, "extensions", "demo", "openclaw.plugin.json");
    writePersistedIndex({ manifestPath, pluginId: "demo", stateDir });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    const readSpy = vi.spyOn(fs, "readFileSync");

    try {
      loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    } finally {
      readSpy.mockRestore();
    }

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(1);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(1);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["manifest", "openclaw.plugin.json", "manifestPath"],
    ["source", "index.js", "source"],
    ["setup source", "setup.js", "setupSource"],
    ["package manifest", "package.json", "packageJsonPath"],
  ])("refreshes when persisted plugin %s changes in the same process", (_, fileName, field) => {
    const stateDir = tempStateDir();
    const filePath = path.join(stateDir, "extensions", "demo", fileName);
    writePersistedIndex({ [field]: filePath, pluginId: "demo", stateDir });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    writeJson(filePath, { id: "demo", version: "0.2.0" });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "install path package manifest",
      "~/tracked-plugin",
      (recordPath: string) => ({ source: "path", installPath: recordPath }),
      (homeDir: string) => path.join(homeDir, "tracked-plugin", "package.json"),
    ],
    [
      "source path package manifest",
      "~/tracked-plugin",
      (recordPath: string) => ({ source: "path", sourcePath: recordPath }),
      (homeDir: string) => path.join(homeDir, "tracked-plugin", "package.json"),
    ],
  ])(
    "refreshes when home-relative install record %s changes",
    (_, recordPath, record, targetPath) => {
      const stateDir = tempStateDir();
      const homeDir = path.join(stateDir, "home");
      const filePath = targetPath(homeDir);
      writePersistedInstallRecords(stateDir, { demo: record(recordPath) });
      writeJson(filePath, { version: "1.0.0" });
      loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source: "persisted",
        snapshot: makeIndex(),
        diagnostics: [],
      });

      loadPluginMetadataSnapshot({ config: {}, env: { HOME: homeDir }, stateDir });
      writeJson(filePath, { version: "1.0.1000" });
      loadPluginMetadataSnapshot({ config: {}, env: { HOME: homeDir }, stateDir });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
      expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(2);
    },
  );

  it("does not reuse home-relative install record watches across env changes", () => {
    const stateDir = tempStateDir();
    const firstHomeDir = path.join(stateDir, "first-home");
    const secondHomeDir = path.join(stateDir, "second-home");
    const firstPackageJsonPath = path.join(firstHomeDir, "tracked-plugin", "package.json");
    const secondPackageJsonPath = path.join(secondHomeDir, "tracked-plugin", "package.json");
    writePersistedInstallRecords(stateDir, {
      demo: { source: "path", installPath: "~/tracked-plugin" },
    });
    writeJson(firstPackageJsonPath, { version: "1.0.0" });
    writeJson(secondPackageJsonPath, { version: "1.0.0" });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });

    loadPluginMetadataSnapshot({ config: {}, env: { HOME: firstHomeDir }, stateDir });
    loadPluginMetadataSnapshot({ config: {}, env: { HOME: secondHomeDir }, stateDir });
    writeJson(secondPackageJsonPath, { version: "1.0.1000" });
    loadPluginMetadataSnapshot({ config: {}, env: { HOME: secondHomeDir }, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(3);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(3);
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
      version: "1.0.10",
      writeRootManifest: false,
    });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(2);
  });

  it("refreshes when a declared recovered managed npm package appears", () => {
    const stateDir = tempStateDir();
    writeJson(path.join(stateDir, "npm", "package.json"), {
      dependencies: {
        "late-plugin": "1.0.0",
      },
    });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    writeRecoverableNpmPlugin({
      packageName: "late-plugin",
      pluginId: "late-plugin",
      stateDir,
      version: "1.0.0",
      writeRootManifest: false,
    });
    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(2);
  });

  it("refreshes when an in-root package manifest symlink target changes", () => {
    const stateDir = tempStateDir();
    const pluginDir = path.join(stateDir, "extensions", "demo");
    const packageJsonPath = path.join(pluginDir, "package.json");
    const outsidePackageJsonPath = path.join(stateDir, "outside", "package.json");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeJson(outsidePackageJsonPath, { name: "outside", version: "1.0.0" });
    fs.symlinkSync(outsidePackageJsonPath, packageJsonPath);
    writePersistedIndex({ packageJsonPath, pluginId: "demo", stateDir });
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: makeIndex(),
      diagnostics: [],
    });

    loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    writeJson(outsidePackageJsonPath, { name: "outside", version: "1.0.1" });
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
