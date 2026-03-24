import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";
import {
  applyStatusScanDefaults,
  createStatusMemorySearchConfig,
  createStatusMemorySearchManager,
  createStatusScanConfig,
  createStatusSummary,
  withTemporaryEnv,
} from "./status.scan.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveConfigPath: vi.fn(() => `/tmp/openclaw-status-scan-missing-${process.pid}.json`),
  hasPotentialConfiguredChannels: vi.fn(),
  readBestEffortConfig: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  buildChannelsTable: vi.fn(),
  callGateway: vi.fn(),
  getUpdateCheckResult: vi.fn(),
  getAgentLocalStatuses: vi.fn(),
  getStatusSummary: vi.fn(),
  getMemorySearchManager: vi.fn(),
  buildGatewayConnectionDetails: vi.fn(),
  probeGateway: vi.fn(),
  resolveGatewayProbeAuthResolution: vi.fn(),
  ensurePluginRegistryLoaded: vi.fn(),
  buildPluginCompatibilityNotices: vi.fn(() => []),
}));

let originalForceStderr: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  originalForceStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = false;
  configureScanStatus();
});

afterEach(() => {
  loggingState.forceConsoleToStderr = originalForceStderr;
});

vi.mock("../channels/config-presence.js", () => ({
  hasPotentialConfiguredChannels: mocks.hasPotentialConfiguredChannels,
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: vi.fn(async (_opts, run) => await run({ setLabel: vi.fn(), tick: vi.fn() })),
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
}));

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveConfigPath: mocks.resolveConfigPath,
  };
});

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("./status-all/channels.js", () => ({
  buildChannelsTable: mocks.buildChannelsTable,
}));

vi.mock("./status.scan.runtime.js", () => ({
  statusScanRuntime: {
    buildChannelsTable: mocks.buildChannelsTable,
    collectChannelStatusIssues: vi.fn(() => []),
  },
}));

vi.mock("./status.update.js", () => ({
  getUpdateCheckResult: mocks.getUpdateCheckResult,
}));

vi.mock("./status.agent-local.js", () => ({
  getAgentLocalStatuses: mocks.getAgentLocalStatuses,
}));

vi.mock("./status.summary.js", () => ({
  getStatusSummary: mocks.getStatusSummary,
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: vi.fn(() => ({ label: "test-os" })),
}));

vi.mock("./status.scan.deps.runtime.js", () => ({
  getTailnetHostname: vi.fn(),
  getMemorySearchManager: mocks.getMemorySearchManager,
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
  callGateway: mocks.callGateway,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

vi.mock("./status.gateway-probe.js", () => ({
  pickGatewaySelfPresence: vi.fn(() => null),
  resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
}));

vi.mock("../cli/plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: mocks.ensurePluginRegistryLoaded,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilityNotices: mocks.buildPluginCompatibilityNotices,
}));

import { scanStatus } from "./status.scan.js";

function configureScanStatus(
  options: {
    hasConfiguredChannels?: boolean;
    sourceConfig?: ReturnType<typeof createStatusScanConfig>;
    resolvedConfig?: ReturnType<typeof createStatusScanConfig>;
    summary?: ReturnType<typeof createStatusSummary>;
    update?: false;
    gatewayProbe?: false;
    memoryConfigured?: boolean;
  } = {},
) {
  const sourceConfig = options.memoryConfigured
    ? createStatusMemorySearchConfig()
    : (options.sourceConfig ?? createStatusScanConfig());
  const resolvedConfig = options.memoryConfigured
    ? createStatusMemorySearchConfig()
    : (options.resolvedConfig ?? sourceConfig);

  applyStatusScanDefaults(mocks, {
    hasConfiguredChannels: options.hasConfiguredChannels,
    sourceConfig,
    resolvedConfig,
    summary: options.summary,
    update: options.update,
    gatewayProbe: options.gatewayProbe,
    ...(options.memoryConfigured ? { memoryManager: createStatusMemorySearchManager() } : {}),
  });
  mocks.buildChannelsTable.mockResolvedValue({
    rows: [],
    details: [],
  });
  mocks.callGateway.mockResolvedValue(null);
}

describe("scanStatus", () => {
  it("passes sourceConfig into buildChannelsTable for summary-mode status output", async () => {
    configureScanStatus({
      sourceConfig: createStatusScanConfig({
        marker: "source",
        plugins: { enabled: false },
      }),
      resolvedConfig: createStatusScanConfig({
        marker: "resolved",
        plugins: { enabled: false },
      }),
      summary: createStatusSummary({ linkChannel: { linked: false } }),
    });

    await scanStatus({ json: false }, {} as never);

    expect(mocks.buildChannelsTable).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "resolved" }),
      expect.objectContaining({
        sourceConfig: expect.objectContaining({ marker: "source" }),
      }),
    );
  });

  it("skips channel plugin preload for status --json with no channel config", async () => {
    configureScanStatus({
      sourceConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
      resolvedConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
  });

  it("skips plugin compatibility loading for status --json when the config file is missing", async () => {
    configureScanStatus({
      sourceConfig: createStatusScanConfig({
        plugins: { enabled: true },
      }),
      resolvedConfig: createStatusScanConfig({
        plugins: { enabled: true },
      }),
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
  });

  it("skips plugin compatibility loading for status --json even with configured channels", async () => {
    configureScanStatus({
      hasConfiguredChannels: true,
      sourceConfig: createStatusScanConfig({
        channels: { discord: {} },
      }),
      resolvedConfig: createStatusScanConfig({
        channels: { discord: {} },
      }),
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
  });

  it("skips gateway and update probes on cold-start status paths", async () => {
    configureScanStatus({
      sourceConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
      resolvedConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
      update: false,
      gatewayProbe: false,
    });

    await scanStatus({ json: true }, {} as never);
    await scanStatus({ json: false }, {} as never);

    expect(mocks.getUpdateCheckResult).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });

  it("skips memory backend inspection for default memory-core with no existing store", async () => {
    configureScanStatus();

    await scanStatus({ json: true }, {} as never);

    expect(mocks.getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("inspects memory backend when memory search is explicitly configured", async () => {
    configureScanStatus({ memoryConfigured: true });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.getMemorySearchManager).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            memorySearch: expect.any(Object),
          }),
        }),
      }),
      agentId: "main",
      purpose: "status",
    });
  });

  it("preloads configured channel plugins for status --json when channel config exists", async () => {
    configureScanStatus({
      hasConfiguredChannels: true,
      sourceConfig: createStatusScanConfig({
        plugins: { enabled: false },
        channels: { telegram: { enabled: false } },
      }),
      resolvedConfig: createStatusScanConfig({
        plugins: { enabled: false },
        channels: { telegram: { enabled: false } },
      }),
      summary: createStatusSummary({ linkChannel: { linked: false } }),
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
    // Verify plugin logs were routed to stderr during loading and restored after
    expect(loggingState.forceConsoleToStderr).toBe(false);
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ detailLevel: "presence" }),
    );
    expect(mocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "channels.status" }),
    );
  });

  it("preloads configured channel plugins for status --json when channel auth is env-only", async () => {
    configureScanStatus({
      hasConfiguredChannels: true,
      sourceConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
      resolvedConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
      summary: createStatusSummary({ linkChannel: { linked: false } }),
    });

    await withTemporaryEnv({ MATRIX_ACCESS_TOKEN: "token" }, async () => {
      await scanStatus({ json: true }, {} as never);
    });

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
  });
});
