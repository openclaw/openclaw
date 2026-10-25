import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataRegistrySnapshotMock = vi.hoisted(() => vi.fn());
const resolveConfiguredChannelPluginIdsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

// mock-isolation: Collector-scope fixtures supply channel owners without persisted plugin discovery.
vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIdsAsync: async (...args: unknown[]) =>
    resolveConfiguredChannelPluginIdsMock(...args),
}));

vi.mock("../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime.js")>();
  return {
    ...actual,
    getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  };
});

vi.mock("../plugins/runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: (...args: unknown[]) =>
    loadPluginMetadataRegistrySnapshotMock(...args),
}));

const { runSecurityAuditCore } = await import("./audit.js");

const sourceConfig: OpenClawConfig = {
  agents: { entries: { main: {} } },
  plugins: { allow: ["external-channel-plugin", "audit-plugin"] },
};
function createAuditOptions(
  plugins: Parameters<typeof runSecurityAuditCore>[0]["plugins"] = [],
): Parameters<typeof runSecurityAuditCore>[0] {
  return {
    config: sourceConfig,
    sourceConfig,
    env: {},
    platform: process.platform,
    includeFilesystem: false,
    deep: false,
    deepTimeoutMs: 5000,
    stateDir: "/tmp/openclaw-test-state",
    configPath: "/tmp/openclaw-test-config.json",
    plugins,
    loadPluginSecurityCollectors: true,
    configSnapshot: null,
  };
}

function expectNoCollectorDiscovery() {
  for (const mock of [
    getActivePluginRegistryMock,
    applyPluginAutoEnableMock,
    loadPluginMetadataRegistrySnapshotMock,
  ]) {
    expect(mock).not.toHaveBeenCalled();
  }
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
    "excludes configured channel collectors only when audited: %s",
    async (audited) => {
      applyPluginAutoEnableMock.mockReturnValue({
        config: sourceConfig,
        changes: [],
        autoEnabledReasons: {
          "external-channel-plugin": ["channel:external"],
          "audit-plugin": ["explicit"],
        },
      });
      resolveConfiguredChannelPluginIdsMock.mockReturnValue(["external-channel-plugin"]);

      await runSecurityAuditCore(
        createAuditOptions(audited ? ([{ id: "external-channel-plugin" }] as never) : []),
      );

      const params = resolveConfiguredChannelPluginIdsMock.mock.calls[0]?.[0];
      expect(params?.config).toBe(sourceConfig);
      expect(params?.activationSourceConfig).toBe(sourceConfig);
      expect(params?.env).toStrictEqual({});
      expect(
        loadPluginMetadataRegistrySnapshotMock.mock.calls[0]?.[0]?.onlyPluginIds,
      ).toStrictEqual(audited ? ["audit-plugin"] : ["external-channel-plugin", "audit-plugin"]);
    },
  );

  it("skips plugin runtime and collector discovery when collector loading is disabled", async () => {
    const report = await runSecurityAuditCore({
      ...createAuditOptions(),
      loadPluginSecurityCollectors: false,
    });

    expect(report.findings.some((finding) => finding.checkId.startsWith("plugins."))).toBe(false);
    expectNoCollectorDiscovery();
  });

  it("keeps plain security audit off plugin collector runtime discovery by default", async () => {
    await runSecurityAuditCore({
      config: sourceConfig,
      sourceConfig,
      env: {},
      includeFilesystem: false,
      plugins: [],
      stateDir: "/tmp/openclaw-test-state",
      configPath: "/tmp/openclaw-test-config.json",
    });

    expectNoCollectorDiscovery();
  });
});
