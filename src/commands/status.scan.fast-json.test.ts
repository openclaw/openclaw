import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasPotentialConfiguredChannels: vi.fn(),
  readBestEffortConfig: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getUpdateCheckResult: vi.fn(),
  getAgentLocalStatuses: vi.fn(),
  getStatusSummary: vi.fn(),
  getMemorySearchManager: vi.fn(),
  getTailnetHostname: vi.fn(),
  buildGatewayConnectionDetails: vi.fn(),
  probeGateway: vi.fn(),
  resolveGatewayProbeAuthResolution: vi.fn(),
  ensurePluginRegistryLoaded: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPotentialConfiguredChannels.mockReturnValue(false);
});

vi.mock("../channels/config-presence.js", () => ({
  hasPotentialConfiguredChannels: mocks.hasPotentialConfiguredChannels,
}));

vi.mock("../config/io.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getStatusCommandSecretTargetIds: vi.fn(() => []),
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
  getTailnetHostname: mocks.getTailnetHostname,
  getMemorySearchManager: mocks.getMemorySearchManager,
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
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

import { scanStatusJsonFast } from "./status.scan.fast-json.js";

describe("scanStatusJsonFast", () => {
  it("falls back when the tailscale probe never settles", async () => {
    vi.useFakeTimers();
    mocks.getTailnetHostname.mockImplementation(() => new Promise(() => {}));
    mocks.readBestEffortConfig.mockResolvedValue({
      session: {},
      plugins: { enabled: false },
      gateway: { tailscale: { mode: "serve" } },
    });
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: {
        session: {},
        plugins: { enabled: false },
        gateway: { tailscale: { mode: "serve" } },
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

    try {
      const scanPromise = scanStatusJsonFast({ all: false, timeoutMs: undefined }, {} as never);
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await scanPromise;

      expect(result.tailscaleDns).toBeNull();
      expect(result.tailscaleHttpsUrl).toBeNull();
    } finally {
      mocks.getTailnetHostname.mockReset();
      vi.useRealTimers();
    }
  });
});
