import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataRegistrySnapshotMock = vi.hoisted(() =>
  vi.fn<(params: { onlyPluginIds?: string[] }) => { securityAuditCollectors: unknown[] }>(),
);
const resolveConfiguredChannelPluginIdsMock = vi.hoisted(() =>
  vi.fn<
    (params: { config?: unknown; activationSourceConfig?: unknown; env?: unknown }) => string[]
  >(),
);

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

// mock-isolation: Collector-scope fixtures supply channel owners without persisted plugin discovery.
vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIdsAsync: async (
    ...args: Parameters<typeof resolveConfiguredChannelPluginIdsMock>
  ) => resolveConfiguredChannelPluginIdsMock(...args),
}));

vi.mock("../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime.js")>();
  return {
    ...actual,
    getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  };
});

vi.mock("../plugins/runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: loadPluginMetadataRegistrySnapshotMock,
}));

const { runSecurityAuditCore } = await import("./audit.js");

type AuditOptions = Parameters<typeof runSecurityAuditCore>[0];
function createAuditOptions(
  sourceConfig: OpenClawConfig,
  plugins: AuditOptions["plugins"],
): AuditOptions {
  return {
    config: sourceConfig,
    sourceConfig,
    env: {},
    platform: process.platform,
    includeFilesystem: false,
    includeChannelSecurity: true,
    deep: false,
    deepTimeoutMs: 5000,
    stateDir: "/tmp/openclaw-test-state",
    configPath: "/tmp/openclaw-test-config.json",
    plugins,
    loadPluginSecurityCollectors: true,
    configSnapshot: null,
  };
}

const createSourceConfig = (allow = ["external-channel-plugin", "audit-plugin"]) => ({
  agents: { entries: { main: {} } },
  plugins: { allow },
});

function configureChannelOwner(sourceConfig: OpenClawConfig) {
  applyPluginAutoEnableMock.mockReturnValue({
    config: sourceConfig,
    changes: [],
    autoEnabledReasons: {
      "external-channel-plugin": ["channel:external"],
      "audit-plugin": ["explicit"],
    },
  });
  resolveConfiguredChannelPluginIdsMock.mockReturnValue(["external-channel-plugin"]);
}

function expectNoDiscovery() {
  expect(getActivePluginRegistryMock).not.toHaveBeenCalled();
  expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
  expect(loadPluginMetadataRegistrySnapshotMock).not.toHaveBeenCalled();
}

describe("security audit read-only plugin scope", () => {
  beforeEach(() => {
    applyPluginAutoEnableMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    loadPluginMetadataRegistrySnapshotMock.mockReset();
    resolveConfiguredChannelPluginIdsMock.mockReset();
    getActivePluginRegistryMock.mockReturnValue(null);
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
      autoEnabledReasons: {},
    }));
    loadPluginMetadataRegistrySnapshotMock.mockReturnValue({
      securityAuditCollectors: [],
    });
    resolveConfiguredChannelPluginIdsMock.mockReturnValue([]);
  });

  it.each([false, true])(
    "deduplicates only channel owners audited by channel security: %s",
    async (audited) => {
      const sourceConfig = createSourceConfig();
      configureChannelOwner(sourceConfig);
      const plugins = audited ? ([{ id: "external-channel-plugin" }] as never) : [];
      await runSecurityAuditCore(createAuditOptions(sourceConfig, plugins));
      const resolveConfiguredChannelPluginIdsParams =
        resolveConfiguredChannelPluginIdsMock.mock.calls[0][0];
      expect(resolveConfiguredChannelPluginIdsParams.config).toBe(sourceConfig);
      expect(resolveConfiguredChannelPluginIdsParams.activationSourceConfig).toBe(sourceConfig);
      expect(resolveConfiguredChannelPluginIdsParams.env).toStrictEqual({});

      expect(loadPluginMetadataRegistrySnapshotMock.mock.calls[0][0].onlyPluginIds).toStrictEqual(
        audited ? ["audit-plugin"] : ["external-channel-plugin", "audit-plugin"],
      );
    },
  );

  it("skips plugin runtime and collector discovery when collector loading is disabled", async () => {
    const sourceConfig = createSourceConfig(["audit-plugin"]);
    const report = await runSecurityAuditCore({
      ...createAuditOptions(sourceConfig, []),
      loadPluginSecurityCollectors: false,
    });

    expect(report.findings.some((finding) => finding.checkId.startsWith("plugins."))).toBe(false);
    expectNoDiscovery();
  });

  it("keeps plain security audit off plugin collector runtime discovery by default", async () => {
    const sourceConfig = createSourceConfig(["audit-plugin"]);
    await runSecurityAuditCore({
      config: sourceConfig,
      sourceConfig,
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
      stateDir: "/tmp/openclaw-test-state",
      configPath: "/tmp/openclaw-test-config.json",
    });

    expectNoDiscovery();
  });
});
