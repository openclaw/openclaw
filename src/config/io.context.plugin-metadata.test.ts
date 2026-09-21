import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearBundledDiscoveryModeMemo } from "../plugins/bundled-discovery-state.js";
import {
  recordPluginCandidateInstallOwner,
  resolvePluginCandidateInstallOwner,
} from "../plugins/candidate-install-owner.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index-types.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { buildPluginMetadataProviderFacts } from "../plugins/plugin-metadata-provider-facts.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { buildDeclaredProviderOwnerIndex } from "../plugins/provider-owner-index.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const mocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshotInput: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshotInput,
  resolvePluginMetadataSnapshotInput: mocks.resolvePluginMetadataSnapshotInput,
}));

const { resolveReadOnlyChannelPluginsForConfig } = await import("../channels/plugins/read-only.js");
const { createConfigIoContext } = await import("./io.context.js");
const {
  resolveConfigWidePluginMetadataSnapshot,
  resolveConfigWidePluginMetadataSnapshotAsync,
  resolveConfigWidePluginManifestRegistry,
} = await import("./io.plugin-metadata.js");

const { migratePersistedImplicitMainRoster } = await import("./legacy.roster.js");
const { validateConfigObjectWithPlugins, validateConfigObjectWithPluginsAsync } =
  await import("./validation.js");

const agents = {
  ownership: "explicit" as const,
  entries: {
    ops: { workspace: "/srv/ops" },
    research: { workspace: "/srv/research" },
  },
};

function manifestRecord(params: {
  id: string;
  source: string;
  channels?: string[];
}): PluginManifestRecord {
  return {
    id: params.id,
    name: params.id,
    description: "test plugin",
    version: "1.0.0",
    source: params.source,
    rootDir: params.source,
    manifestPath: `${params.source}/openclaw.plugin.json`,
    origin: "workspace",
    channels: params.channels ?? [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
  };
}

function workspaceSnapshot(
  workspaceDir: string,
  plugins: PluginManifestRecord[],
  disabledIds: readonly string[] = [],
  policyHash = "test",
) {
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 1,
    workspaceDir,
    installRecords: {},
    diagnostics: [],
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.id,
      source: plugin.source,
      manifestPath: plugin.manifestPath,
      manifestHash: "test",
      rootDir: plugin.rootDir,
      origin: plugin.origin,
      enabled: !disabledIds.includes(plugin.id),
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      compat: [],
    })),
  };
  return restorePluginMetadataSnapshot({
    workspaceDir,
    policyHash,
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(plugins),
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
      providerAuthContributions:
        buildPluginMetadataProviderFacts(plugins).providerAuthContributions,
      modelIdNormalizationPolicies: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: plugins.length,
      manifestPluginCount: plugins.length,
    },
    discovery: {
      candidates: plugins.map((plugin) =>
        recordPluginCandidateInstallOwner(
          {
            idHint: plugin.id,
            source: plugin.source,
            rootDir: plugin.rootDir,
            origin: plugin.origin,
            workspaceDir,
          },
          plugin.id,
        ),
      ),
      diagnostics: [],
    },
  });
}

describe("config IO plugin metadata snapshots", () => {
  beforeEach(() => {
    clearCurrentPluginMetadataSnapshot();
    clearPluginMetadataLifecycleCaches();
    mocks.resolvePluginMetadataSnapshotInput.mockReset();
  });

  it("shares first-access inventory across config reads and alternating plugin selections", () => {
    const primary = manifestRecord({ id: "primary", source: "/srv/ops/primary" });
    const secondary = manifestRecord({ id: "secondary", source: "/srv/research/secondary" });
    const snapshots = new Map([
      ["/srv/ops", workspaceSnapshot("/srv/ops", [primary])],
      ["/srv/research", workspaceSnapshot("/srv/research", [secondary])],
    ]);
    mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );
    const config = { agents };
    for (let read = 0; read < 2; read++) {
      const context = createConfigIoContext({ env: {}, observe: false });
      const loader = context.createValidationPluginMetadataSnapshotLoader({
        effectiveConfigRaw: config,
        env: {},
      });
      loader.load(config);
      expect(loader.getSnapshot()?.plugins.map((plugin) => plugin.id)).toEqual([
        "primary",
        "secondary",
      ]);
    }
    for (const pluginId of ["primary", "secondary", "primary"]) {
      expect(
        resolveConfigWidePluginManifestRegistry({
          config,
          env: {},
          pluginIds: [pluginId],
        }).plugins.map((plugin) => plugin.id),
      ).toEqual([pluginId]);
    }
    expect(mocks.resolvePluginMetadataSnapshotInput).toHaveBeenCalledTimes(2);
  });

  it("reuses compatible Gateway metadata inside an isolated reload operation", async () => {
    const prepared = manifestRecord({ id: "prepared", source: "/srv/ops/prepared" });
    const config = {
      agents: { entries: { ops: { workspace: "/srv/ops" } } },
      logging: { level: "info" as const },
      plugins: { entries: { prepared: { enabled: true } } },
    };
    const snapshot = workspaceSnapshot(
      "/srv/ops",
      [prepared],
      [],
      resolveInstalledPluginIndexPolicyHash(config, {}),
    );
    setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });
    mocks.resolvePluginMetadataSnapshotInput.mockReturnValue(snapshot);

    const loggingOnly = withPluginCache(createPluginCache(), () =>
      resolveConfigWidePluginMetadataSnapshot({
        config: { ...config, logging: { level: "debug" } },
        env: {},
      }),
    );
    expect(loggingOnly).toBe(snapshot);
    expect(mocks.resolvePluginMetadataSnapshotInput).not.toHaveBeenCalled();

    clearBundledDiscoveryModeMemo();
    const asyncLoggingOnly = await withPluginCache(createPluginCache(), () =>
      resolveConfigWidePluginMetadataSnapshotAsync({
        config: { ...config, logging: { level: "warn" } },
        env: {},
      }),
    );
    expect(asyncLoggingOnly).toBe(snapshot);
    expect(mocks.resolvePluginMetadataSnapshotInput).not.toHaveBeenCalled();

    withPluginCache(createPluginCache(), () =>
      resolveConfigWidePluginMetadataSnapshot({
        config: {
          ...config,
          plugins: { ...config.plugins, load: { paths: ["/srv/new-plugin"] } },
        },
        env: {},
      }),
    );
    expect(mocks.resolvePluginMetadataSnapshotInput).toHaveBeenCalledTimes(1);
  });

  it.each(["sync", "async"] as const)(
    "reuses Gateway metadata through %s config validation",
    async (mode) => {
      const config: OpenClawConfig = {
        agents: { entries: { ops: { workspace: "/srv/ops" } } },
        logging: { level: "info" },
      };
      const prepared = manifestRecord({ id: "prepared", source: "/srv/ops/prepared" });
      const snapshot = workspaceSnapshot(
        "/srv/ops",
        [prepared],
        [],
        resolveInstalledPluginIndexPolicyHash(config, {}),
      );
      setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });
      mocks.resolvePluginMetadataSnapshotInput.mockReturnValue(snapshot);
      const nextConfig = { ...config, logging: { level: "debug" } };
      const loader = createConfigIoContext({
        env: {},
        observe: false,
      }).createValidationPluginMetadataSnapshotLoader({ effectiveConfigRaw: nextConfig, env: {} });

      const result = await withPluginCache(createPluginCache(), () =>
        mode === "sync"
          ? validateConfigObjectWithPlugins(nextConfig, {
              env: {},
              loadPluginMetadataSnapshot: loader.load,
            })
          : validateConfigObjectWithPluginsAsync(nextConfig, {
              env: {},
              loadPluginMetadataSnapshotAsync: loader.loadAsync,
            }),
      );

      expect(result.ok).toBe(true);
      expect(loader.getSnapshot()).toBe(snapshot);
      expect(mocks.resolvePluginMetadataSnapshotInput).not.toHaveBeenCalled();
    },
  );

  it("discovers the new workspace when reload changes legacy default ownership", async () => {
    const legacyConfig = (defaultAgent: "ops" | "research") => ({
      agents: {
        defaults: { workspace: "/srv/base" },
        entries: {
          ops: { default: defaultAgent === "ops" },
          research: { default: defaultAgent === "research" },
        },
      },
    });
    const config = migratePersistedImplicitMainRoster(legacyConfig("ops")).config as OpenClawConfig;
    const policyHash = resolveInstalledPluginIndexPolicyHash(config, {});
    const initial = workspaceSnapshot("/srv/base", [], [], policyHash);
    setGatewayPluginMetadataSnapshot(initial, { config, env: {} });
    const added = manifestRecord({ id: "new-workspace-plugin", source: "/srv/base/ops/plugin" });
    const snapshots = new Map([
      ["/srv/base", workspaceSnapshot("/srv/base", [], [], policyHash)],
      ["/srv/base/ops", workspaceSnapshot("/srv/base/ops", [added], [], policyHash)],
    ]);
    mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );
    const nextConfig = legacyConfig("research");
    const loader = createConfigIoContext({
      env: {},
      observe: false,
    }).createValidationPluginMetadataSnapshotLoader({ effectiveConfigRaw: nextConfig, env: {} });

    const result = await withPluginCache(createPluginCache(), () =>
      validateConfigObjectWithPluginsAsync(nextConfig, {
        env: {},
        loadPluginMetadataSnapshotAsync: loader.loadAsync,
      }),
    );

    expect(result.ok).toBe(true);
    expect(loader.getSnapshot()?.plugins.map((plugin) => plugin.id)).toEqual([added.id]);
    expect(
      mocks.resolvePluginMetadataSnapshotInput.mock.calls.map(([params]) => params.workspaceDir),
    ).toEqual(["/srv/base/ops", "/srv/base"]);
  });

  it("rejects Gateway metadata when the configured workspace set changes", async () => {
    const prepared = manifestRecord({ id: "prepared", source: "/srv/ops/prepared" });
    const config = {
      agents: {
        entries: {
          ops: { workspace: "/srv/ops" },
          research: { workspace: "/srv/research" },
        },
      },
    };
    const snapshot = workspaceSnapshot(
      "/srv/ops",
      [prepared],
      [],
      resolveInstalledPluginIndexPolicyHash(config, {}),
    );
    setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });
    mocks.resolvePluginMetadataSnapshotInput.mockReturnValue(snapshot);

    const changedConfigs: OpenClawConfig[] = [
      { agents: { entries: { ops: { workspace: "/srv/ops" } } } },
      {
        agents: {
          entries: {
            ops: { workspace: "/srv/ops" },
            research: { workspace: "/srv/analysis" },
          },
        },
      },
      {
        agents: {
          entries: {
            ops: { workspace: "/srv/ops" },
            research: { workspace: "/srv/research" },
            support: { workspace: "/srv/support" },
          },
        },
      },
    ];
    for (const [index, changedConfig] of changedConfigs.entries()) {
      mocks.resolvePluginMetadataSnapshotInput.mockClear();
      if (index === 1) {
        await withPluginCache(createPluginCache(), () =>
          resolveConfigWidePluginMetadataSnapshotAsync({ config: changedConfig, env: {} }),
        );
      } else {
        withPluginCache(createPluginCache(), () =>
          resolveConfigWidePluginMetadataSnapshot({ config: changedConfig, env: {} }),
        );
      }
      expect(mocks.resolvePluginMetadataSnapshotInput).toHaveBeenCalledTimes(index + 1);
    }
  });

  it("feeds merged workspace plugins to snapshot-backed read-only discovery", () => {
    const primary = manifestRecord({ id: "primary", source: "/srv/ops/primary" });
    const secondary = manifestRecord({
      id: "research-chat-plugin",
      source: "/srv/research/research-chat-plugin",
      channels: ["research-chat"],
    });
    const mergedRegistry = { plugins: [primary, secondary], diagnostics: [] };
    const secondaryDiagnostic = {
      level: "warn" as const,
      code: "persisted-registry-stale-source" as const,
      message: "Retained secondary registry metadata",
    };
    const snapshots = new Map([
      ["/srv/ops", workspaceSnapshot("/srv/ops", [primary], ["primary"])],
      [
        "/srv/research",
        {
          ...workspaceSnapshot("/srv/research", [secondary]),
          registryDiagnostics: [secondaryDiagnostic],
        },
      ],
    ]);
    mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );
    const cfg = {
      agents,
      channels: { "research-chat": { enabled: true } },
      plugins: {
        allow: ["research-chat-plugin"],
        entries: { "research-chat-plugin": { enabled: true } },
      },
    };
    const context = createConfigIoContext({ env: {}, observe: false });
    const loader = context.createValidationPluginMetadataSnapshotLoader({
      effectiveConfigRaw: cfg,
      env: {},
    });
    loader.load(cfg);
    const snapshot = loader.getSnapshot();

    expect(snapshot?.index.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "primary",
      "research-chat-plugin",
    ]);
    expect(snapshot?.registryIndex).toEqual(snapshots.get("/srv/ops")?.registryIndex);
    expect(snapshot?.registryIndex.plugins.map((plugin) => plugin.pluginId)).toEqual(["primary"]);
    expect(snapshot?.registryDiagnostics).toEqual([secondaryDiagnostic]);
    expect(snapshot?.plugins).toEqual(mergedRegistry.plugins);
    expect(structuredClone(snapshot?.manifestRegistry)).toEqual(mergedRegistry);
    expect(snapshot?.index.plugins.find((plugin) => plugin.pluginId === "primary")?.enabled).toBe(
      false,
    );
    expect(snapshot?.byPluginId.get("research-chat-plugin")).toBe(secondary);
    expect(snapshot?.owners.channels.get("research-chat")).toEqual(["research-chat-plugin"]);
    expect(snapshot?.discovery?.candidates.map((candidate) => candidate.workspaceDir)).toEqual([
      "/srv/ops",
      "/srv/research",
    ]);
    expect(snapshot?.discovery?.candidates.map(resolvePluginCandidateInstallOwner)).toEqual([
      "primary",
      "research-chat-plugin",
    ]);
    expect(Object.isFrozen(snapshot?.index.plugins)).toBe(true);
    expect(loader.getSnapshot()).toBe(snapshot);
    expect(
      resolveReadOnlyChannelPluginsForConfig(cfg, {
        env: {},
        metadataSnapshot: snapshot,
      }).plugins.map((plugin) => plugin.id),
    ).toContain("research-chat");
  });

  it("preserves shared source order and rejects conflicting IDs throughout the inventory", () => {
    const primary = manifestRecord({ id: "primary", source: "/srv/ops/primary" });
    const shared = manifestRecord({ id: "shared", source: "/plugins/shared" });
    const secondary = manifestRecord({ id: "secondary", source: "/srv/research/secondary" });
    const snapshots = new Map([
      [
        "/srv/ops",
        workspaceSnapshot("/srv/ops", [
          primary,
          shared,
          manifestRecord({ id: "conflict", source: "/srv/ops/conflict" }),
        ]),
      ],
      [
        "/srv/research",
        workspaceSnapshot("/srv/research", [
          secondary,
          shared,
          manifestRecord({ id: "conflict", source: "/srv/research/conflict" }),
        ]),
      ],
    ]);
    mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );

    const snapshot = resolveConfigWidePluginMetadataSnapshot({ config: { agents }, env: {} });

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["primary", "shared", "secondary"]);
    expect(snapshot.index.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "primary",
      "shared",
      "secondary",
    ]);
    expect(snapshot.discovery?.candidates.map((candidate) => candidate.idHint)).toEqual([
      "primary",
      "shared",
      "secondary",
    ]);
    expect(structuredClone(snapshot.manifestRegistry)).toEqual(snapshot.manifestRegistry);
    expect(
      structuredClone(
        resolveConfigWidePluginManifestRegistry({ config: { agents }, env: {}, pluginIds: [] }),
      ).plugins,
    ).toEqual([]);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "conflict",
        message: expect.stringContaining("present in multiple agent workspaces"),
      }),
    );
  });
});
