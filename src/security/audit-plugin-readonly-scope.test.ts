import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataRegistrySnapshotMock = vi.hoisted(() => vi.fn());
const resolveConfiguredChannelPluginIdsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
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
    getActivePluginRegistry: getActivePluginRegistryMock,
  };
});

vi.mock("../plugins/runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: loadPluginMetadataRegistrySnapshotMock,
}));

const { runSecurityAuditCore } = await import("./audit.js");

const sourceConfig: OpenClawConfig = {
  agents: { entries: { main: {} } },
  plugins: { allow: ["external-channel-plugin", "audit-plugin"] },
};
const auditOptions = {
  config: sourceConfig,
  sourceConfig,
  env: {},
  includeFilesystem: false,
  stateDir: "/tmp/openclaw-test-state",
  configPath: "/tmp/openclaw-test-config.json",
  plugins: [],
} satisfies Parameters<typeof runSecurityAuditCore>[0];

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

      await runSecurityAuditCore({
        ...auditOptions,
        loadPluginSecurityCollectors: true,
        plugins: audited ? ([{ id: "external-channel-plugin" }] as never) : [],
      });

      const params = resolveConfiguredChannelPluginIdsMock.mock.calls[0]?.[0];
      expect(params?.config).toBe(sourceConfig);
      expect(params?.activationSourceConfig).toBe(sourceConfig);
      expect(params?.env).toStrictEqual({});
      expect(
        loadPluginMetadataRegistrySnapshotMock.mock.calls[0]?.[0]?.onlyPluginIds,
      ).toStrictEqual(audited ? ["audit-plugin"] : ["external-channel-plugin", "audit-plugin"]);
    },
  );

  it.each([false, undefined])(
    "skips collector discovery when loading is %s",
    async (loadPluginSecurityCollectors) => {
      const report = await runSecurityAuditCore({
        ...auditOptions,
        loadPluginSecurityCollectors,
      });

      expect(report.findings.some((finding) => finding.checkId.startsWith("plugins."))).toBe(false);
      expectNoCollectorDiscovery();
    },
  );
});
