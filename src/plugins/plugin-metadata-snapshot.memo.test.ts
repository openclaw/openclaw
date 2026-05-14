import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
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

function makeIndex(pluginId = "demo"): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "policy",
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
  return {
    plugins: [
      {
        id: pluginId,
        name: pluginId,
        channels: [],
        providers: [pluginId],
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: `/plugins/${pluginId}`,
        source: `/plugins/${pluginId}/index.js`,
        manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
        origin: "global",
      },
    ],
    diagnostics: [],
  };
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
    expect(first.plugins[0]).toBeDefined();
    first.plugins[0]?.providers.push("first-mutated");
    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });
    expect(second.plugins[0]).toBeDefined();
    second.plugins[0]?.providers.push("second-mutated");
    const third = loadPluginMetadataSnapshot({ config: {}, env: {}, stateDir });

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(third.plugins[0]?.providers).toEqual(["demo"]);
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
});
