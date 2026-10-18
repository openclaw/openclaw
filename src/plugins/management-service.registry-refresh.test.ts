import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { managementMetadata } from "./management-service.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const mocks = vi.hoisted(() => {
  // Earlier shared-worker files can cache the real config-wide metadata reader.
  vi.resetModules();
  return {
    clawhubInstall: vi.fn(),
    gatewayMetadata: vi.fn(),
    metadata: vi.fn(),
    officialCatalog: vi.fn(),
    persistInstall: vi.fn(),
    readConfig: vi.fn(),
    refreshRegistry: vi.fn(),
    replaceConfig: vi.fn(),
  };
});

vi.mock("./current-plugin-metadata-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./current-plugin-metadata-state.js")>()),
  getProcessGatewayPluginMetadataSnapshot: () => mocks.gatewayMetadata(),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => undefined,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

// mock-isolation: Registry refresh proofs record persistence without modifying installed plugins.
vi.mock("./install-persistence.js", () => ({
  persistPluginInstall: mocks.persistInstall,
}));

vi.mock("./install-config-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-config-mutation.js")>()),
  resolveInstallConfigMutationPreflights: () => ({
    hookMutation: { mode: "allowed" },
    pluginMutation: { mode: "allowed" },
  }),
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
}));

// mock-isolation: Refresh fixtures supply installation results without downloading packages.
vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: mocks.clawhubInstall,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: async () => ({}),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.metadata,
  resolvePluginMetadataSnapshot: mocks.metadata,
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: mocks.officialCatalog,
}));

// mock-isolation: Tests assert refresh dispatch without publishing to the process registry.
vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshRegistry,
}));

vi.mock("./slot-selection.js", () => ({
  applySlotSelectionForPlugin: (config: unknown) => config,
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { installManagedPlugin, setManagedPluginEnabled } = await import("./management-mutations.js");
const { installManagedPluginSource } = await import("./management-install.js");

const installSnapshot = {
  config: {},
  baseHash: "base-hash",
  writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
};

function readConfig(config: OpenClawConfig, parsed = config) {
  mocks.readConfig.mockResolvedValue({
    snapshot: {
      valid: true,
      parsed,
      path: "/tmp/openclaw.json",
      sourceConfig: config,
      hash: "base-hash",
    },
    writeOptions: installSnapshot.writeOptions,
  });
}

const trackedArtifactDirs: string[] = [];
const emptyArtifactAcknowledgment = {
  reviewToken: computeDeclaredSurfaceHash(
    buildPluginCapabilitySummary({ manifest: {}, origin: "global" }).declared,
  ),
};

function mockClawHubWorkboardInstall() {
  mocks.clawhubInstall.mockImplementation(
    async (params: Parameters<typeof import("./clawhub.js").installPluginFromClawHub>[0]) => {
      const artifactDir = makeTrackedTempDir("managed-registry-consent", trackedArtifactDirs);
      createColdPluginFixture({
        rootDir: artifactDir,
        pluginId: "workboard",
        manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
      });
      await params.onBeforePluginArtifactCommit?.({
        pluginId: "workboard",
        stagedArtifactDir: artifactDir,
        mode: "install",
      });
      return {
        ok: true,
        pluginId: "workboard",
        targetDir: "/tmp/workboard",
        extensions: ["index.js"],
        packageName: "community/workboard",
        clawhub: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "community/workboard",
          clawhubFamily: "code-plugin",
        },
      };
    },
  );
}

function metadataSnapshot(enabled: boolean, installed = false) {
  return managementMetadata({
    enabled,
    curated: false,
    installRecord: installed
      ? { source: "clawhub", spec: "clawhub:community/workboard" }
      : undefined,
  });
}

describe("plugin management registry refresh", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    cleanupTrackedTempDirs(trackedArtifactDirs);
  });

  beforeEach(() => {
    clearManagedPluginCatalogCache();
    vi.resetAllMocks();
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
  });

  it("reports registry refresh warnings after committed enablement", async () => {
    const enabled = true;
    readConfig({ plugins: { entries: { workboard: { enabled: !enabled } } } }, {});
    mocks.replaceConfig.mockResolvedValue({});
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot(!enabled))
      .mockReturnValueOnce(metadataSnapshot(enabled));
    mocks.refreshRegistry.mockImplementation(
      async (params: { logger?: { warn?: (message: string) => void } }) => {
        params.logger?.warn?.("Plugin registry refresh failed: registry unavailable");
      },
    );

    const result = await setManagedPluginEnabled({ pluginId: "workboard", enabled, env: {} });

    expect(mocks.replaceConfig).toHaveBeenCalledOnce();
    expect(result.plugin.enabled).toBe(enabled);
    expect(result.warnings).toEqual(["Plugin registry refresh failed: registry unavailable"]);
  });

  it("keeps an ownerless managed install and returns the partial-scope action", async () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          main: { workspace: "/tmp/main-workspace" },
          gadget: { workspace: "/tmp/gadget-workspace" },
        },
      },
    };
    mockClawHubWorkboardInstall();
    readConfig(config);
    mocks.persistInstall.mockResolvedValue(config);
    mocks.metadata.mockReturnValue(metadataSnapshot(false, true));

    const result = await installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "community/workboard",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });

    expect(result.plugin.id).toBe("workboard");
    expect(result.warnings).toContainEqual(
      expect.stringContaining("set agents.defaults.systemAgent.agentId"),
    );
  });

  it("requires artifact consent before a linked source is enabled or recorded", async () => {
    const artifactDir = makeTrackedTempDir("managed-linked-consent", trackedArtifactDirs);
    const stateDir = makeTrackedTempDir("managed-linked-state", trackedArtifactDirs);
    createColdPluginFixture({
      rootDir: artifactDir,
      pluginId: "linked-plugin",
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    });
    const params = {
      request: {
        source: "local" as const,
        path: artifactDir,
        recordSource: "path" as const,
        mode: "install" as const,
        link: true,
      },
      snapshot: installSnapshot,
      env: { OPENCLAW_STATE_DIR: stateDir },
    };

    await expect(installManagedPluginSource(params)).rejects.toMatchObject({
      capabilityConsent: {
        pluginId: "linked-plugin",
        reviewToken: emptyArtifactAcknowledgment.reviewToken,
      },
    });
    expect(mocks.persistInstall).not.toHaveBeenCalled();

    mocks.persistInstall.mockResolvedValue({});
    const result = await installManagedPluginSource({
      ...params,
      acknowledgeCapabilities: emptyArtifactAcknowledgment,
    });

    expect(result.ok).toBe(true);
    expect(mocks.persistInstall.mock.calls[0]?.[0]).toMatchObject({
      install: {
        installPath: artifactDir,
        acceptedSurfaceHash: emptyArtifactAcknowledgment.reviewToken,
      },
      snapshot: { config: { plugins: { load: { paths: [artifactDir] } } } },
    });
  });
});
