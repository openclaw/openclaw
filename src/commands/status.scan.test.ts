import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBestEffortConfig: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  buildChannelsTable: vi.fn(),
  getUpdateCheckResult: vi.fn(),
  getAgentLocalStatuses: vi.fn(),
  getStatusSummary: vi.fn(),
  buildGatewayConnectionDetails: vi.fn(),
  callGateway: vi.fn(),
  probeGateway: vi.fn(),
  resolveGatewayProbeAuthResolution: vi.fn(),
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
    mocks.callGateway.mockResolvedValue(null);
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

  it("treats missing-scope probe failures as reachable (degraded diagnostics)", async () => {
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
    mocks.callGateway.mockResolvedValue(null);
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 51,
      error: "missing scope: operator.read",
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

    const result = await scanStatus({ json: false }, {} as never);

    expect(result.gatewayReachable).toBe(true);
  });
});
