import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBestEffortConfig: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  buildChannelsTable: vi.fn(),
  callGateway: vi.fn(),
  getUpdateCheckResult: vi.fn(),
  getAgentLocalStatuses: vi.fn(),
  getStatusSummary: vi.fn(),
  buildGatewayConnectionDetails: vi.fn(),
  probeGateway: vi.fn(),
  resolveGatewayProbeAuthResolution: vi.fn(),
  ensurePluginRegistryLoaded: vi.fn(),
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: vi.fn(async (_opts, run) => await run({ setLabel: vi.fn(), tick: vi.fn() })),
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("./status-all/channels.js", () => ({
  buildChannelsTable: mocks.buildChannelsTable,
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

vi.mock("../infra/tailscale.js", () => ({
  getTailnetHostname: vi.fn(),
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

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
}));

vi.mock("../cli/plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: mocks.ensurePluginRegistryLoaded,
}));

import { scanStatus } from "./status.scan.js";

describe("scanStatus", () => {
  it("passes sourceConfig into buildChannelsTable for summary-mode status output", async () => {
    mocks.readBestEffortConfig.mockResolvedValue({
      marker: "source",
      session: {},
      plugins: { enabled: false },
      gateway: {},
    });
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: {
        marker: "resolved",
        session: {},
        plugins: { enabled: false },
        gateway: {},
      },
      diagnostics: [],
    });
    mocks.getUpdateCheckResult.mockResolvedValue({
      installKind: "git",
      git: null,
      registry: null,
    });
    mocks.getAgentLocalStatuses.mockResolvedValue({
      defaultId: "main",
      agents: [],
    });
    mocks.getStatusSummary.mockResolvedValue({
      linkChannel: { linked: false },
      sessions: { count: 0, paths: [], defaults: {}, recent: [] },
    });
    mocks.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "default",
    });
    mocks.resolveGatewayProbeAuthResolution.mockReturnValue({
      auth: {},
      warning: undefined,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    mocks.buildChannelsTable.mockResolvedValue({
      rows: [],
      details: [],
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
    mocks.readBestEffortConfig.mockResolvedValue({
      session: {},
      plugins: { enabled: false },
      gateway: {},
    });
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: {
        session: {},
        plugins: { enabled: false },
        gateway: {},
      },
      diagnostics: [],
    });
    mocks.getUpdateCheckResult.mockResolvedValue({
      installKind: "git",
      git: null,
      registry: null,
    });
    mocks.getAgentLocalStatuses.mockResolvedValue({
      defaultId: "main",
      agents: [],
    });
    mocks.getStatusSummary.mockResolvedValue({
      linkChannel: undefined,
      sessions: { count: 0, paths: [], defaults: {}, recent: [] },
    });
    mocks.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "default",
    });
    mocks.resolveGatewayProbeAuthResolution.mockReturnValue({
      auth: {},
      warning: undefined,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
  });

  it("preloads configured channel plugins for status --json when channel config exists", async () => {
    mocks.readBestEffortConfig.mockResolvedValue({
      session: {},
      plugins: { enabled: false },
      gateway: {},
      channels: { telegram: { enabled: false } },
    });
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: {
        session: {},
        plugins: { enabled: false },
        gateway: {},
        channels: { telegram: { enabled: false } },
      },
      diagnostics: [],
    });
    mocks.getUpdateCheckResult.mockResolvedValue({
      installKind: "git",
      git: null,
      registry: null,
    });
    mocks.getAgentLocalStatuses.mockResolvedValue({
      defaultId: "main",
      agents: [],
    });
    mocks.getStatusSummary.mockResolvedValue({
      linkChannel: { linked: false },
      sessions: { count: 0, paths: [], defaults: {}, recent: [] },
    });
    mocks.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "default",
    });
    mocks.resolveGatewayProbeAuthResolution.mockReturnValue({
      auth: {},
      warning: undefined,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ detailLevel: "presence" }),
    );
    expect(mocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "channels.status" }),
    );
  });

  it("preloads configured channel plugins for status --json when channel auth is env-only", async () => {
    const prevMatrixToken = process.env.MATRIX_ACCESS_TOKEN;
    process.env.MATRIX_ACCESS_TOKEN = "token";
    mocks.readBestEffortConfig.mockResolvedValue({
      session: {},
      plugins: { enabled: false },
      gateway: {},
    });
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: {
        session: {},
        plugins: { enabled: false },
        gateway: {},
      },
      diagnostics: [],
    });
    mocks.getUpdateCheckResult.mockResolvedValue({
      installKind: "git",
      git: null,
      registry: null,
    });
    mocks.getAgentLocalStatuses.mockResolvedValue({
      defaultId: "main",
      agents: [],
    });
    mocks.getStatusSummary.mockResolvedValue({
      linkChannel: { linked: false },
      sessions: { count: 0, paths: [], defaults: {}, recent: [] },
    });
    mocks.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "default",
    });
    mocks.resolveGatewayProbeAuthResolution.mockReturnValue({
      auth: {},
      warning: undefined,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    try {
      await scanStatus({ json: true }, {} as never);
    } finally {
      if (prevMatrixToken === undefined) {
        delete process.env.MATRIX_ACCESS_TOKEN;
      } else {
        process.env.MATRIX_ACCESS_TOKEN = prevMatrixToken;
      }
    }

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
  });
});
