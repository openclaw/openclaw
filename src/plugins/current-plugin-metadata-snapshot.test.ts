import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearCurrentPluginMetadataSnapshot,
  getCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

function createSnapshot(
  params: {
    config?: Parameters<typeof resolveInstalledPluginIndexPolicyHash>[0];
    workspaceDir?: string;
  } = {},
): PluginMetadataSnapshot {
  return {
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    inventoryFingerprint: "test-inventory",
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
}

function createSnapshotWithInventoryFiles(params: {
  config?: Parameters<typeof resolveInstalledPluginIndexPolicyHash>[0];
}): PluginMetadataSnapshot {
  const snapshot = createSnapshot({ config: params.config });
  snapshot.index.plugins = [
    {
      pluginId: "demo",
      manifestPath: "/plugins/demo/openclaw.plugin.json",
      manifestHash: "demo-manifest-hash",
      rootDir: "/plugins/demo",
      origin: "global",
      enabled: true,
      packageJson: {
        path: "package.json",
        hash: "demo-package-hash",
      },
      startup: {
        sidecar: false,
        memory: false,
        deferConfiguredChannelFullLoadUntilAfterListen: false,
        agentHarnesses: [],
      },
      compat: [],
    },
  ];
  snapshot.inventoryFingerprint = "demo-inventory";
  return snapshot;
}

describe("current plugin metadata snapshot", () => {
  it("returns the current snapshot only for matching config policy and workspace", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/a" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir: "/workspace/a" })).toBe(
      snapshot,
    );
    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({
        config: { plugins: { allow: ["other"] } },
        workspaceDir: "/workspace/a",
      }),
    ).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({ config, workspaceDir: "/workspace/b" }),
    ).toBeUndefined();
  });

  it("rejects a workspace-scoped snapshot when the caller does not provide workspace scope", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/a" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
  });

  it("can opt into reusing the stored workspace scope for unscoped control-plane readers", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/a" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(
      getCurrentPluginMetadataSnapshot({
        config,
        allowWorkspaceScopedSnapshot: true,
      }),
    ).toBe(snapshot);
  });

  it("rejects a current snapshot when plugin load paths change", () => {
    const config = { plugins: { load: { paths: ["/plugins/one"] } } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
    expect(
      getCurrentPluginMetadataSnapshot({
        config: { plugins: { load: { paths: ["/plugins/two"] } } },
      }),
    ).toBeUndefined();
  });

  it("rejects configless default-discovery reuse for snapshots created with load paths", () => {
    const config = { plugins: { allow: ["demo"], load: { paths: ["/plugins/one"] } } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(
      getCurrentPluginMetadataSnapshot({
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      }),
    ).toBeUndefined();
  });

  it("accepts configless default-discovery reuse for snapshots created without load paths", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(
      getCurrentPluginMetadataSnapshot({
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      }),
    ).toBe(snapshot);
  });

  it("rejects a current snapshot when env-resolved plugin load paths change", () => {
    const config = { plugins: { load: { paths: ["~/plugins"] } } };
    const snapshot = createSnapshot({ config });
    const snapshotEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const requestedEnv = {
      HOME: "/home/requested",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env: snapshotEnv });

    expect(getCurrentPluginMetadataSnapshot({ config, env: snapshotEnv })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config, env: requestedEnv })).toBeUndefined();
  });

  it("rejects a current snapshot when env-resolved plugin roots change", () => {
    const config = {};
    const snapshot = createSnapshot({ config });
    const snapshotEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const requestedEnv = {
      HOME: "/home/requested",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env: snapshotEnv });

    expect(getCurrentPluginMetadataSnapshot({ config, env: snapshotEnv })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config, env: requestedEnv })).toBeUndefined();
  });

  it("keeps source-policy compatibility when storing an auto-enabled runtime config", () => {
    const sourceConfig = { channels: { telegram: { botToken: "token" } } };
    const autoEnabledConfig = {
      ...sourceConfig,
      plugins: { allow: ["telegram"] },
    };
    const snapshot = createSnapshot({ config: sourceConfig });
    setCurrentPluginMetadataSnapshot(snapshot, { config: autoEnabledConfig });

    expect(getCurrentPluginMetadataSnapshot({ config: sourceConfig })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config: autoEnabledConfig })).toBeUndefined();
  });

  it("accepts explicit compatible configs for gateway runtime reuse", () => {
    const sourceConfig = { channels: { telegram: { botToken: "token" } } };
    const runtimeConfig = {
      ...sourceConfig,
      plugins: { allow: ["telegram"] },
    };
    const snapshot = createSnapshot({ config: sourceConfig, workspaceDir: "/workspace" });
    setCurrentPluginMetadataSnapshot(snapshot, {
      config: sourceConfig,
      compatibleConfigs: [runtimeConfig],
      workspaceDir: "/workspace",
    });

    expect(
      getCurrentPluginMetadataSnapshot({ config: sourceConfig, workspaceDir: "/workspace" }),
    ).toBe(snapshot);
    expect(
      getCurrentPluginMetadataSnapshot({ config: runtimeConfig, workspaceDir: "/workspace" }),
    ).toBe(snapshot);
  });

  it("reuses a current snapshot without restatting plugin inventory files", () => {
    const config = { plugins: { bundledDiscovery: "compat" as const, allow: ["demo"] } };
    const snapshot = createSnapshotWithInventoryFiles({ config });
    const statSync = vi.spyOn(fs, "statSync").mockImplementation((filePath) => {
      throw Object.assign(new Error(`missing fixture file: ${String(filePath)}`), {
        code: "ENOENT",
      });
    });
    try {
      setCurrentPluginMetadataSnapshot(snapshot, { config });
      statSync.mockClear();

      expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
      expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);

      expect(statSync).not.toHaveBeenCalled();
    } finally {
      statSync.mockRestore();
    }
  });

  it("clears the current snapshot", () => {
    setCurrentPluginMetadataSnapshot(createSnapshot());
    clearCurrentPluginMetadataSnapshot();

    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
  });

  it("clears the current snapshot when the persisted installed index changes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-metadata-"));
    try {
      setCurrentPluginMetadataSnapshot(createSnapshot());

      writePersistedInstalledPluginIndexSync(createSnapshot().index, { stateDir: tempDir });

      expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
